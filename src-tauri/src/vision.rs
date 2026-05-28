//! burrowstock — vision.rs
//!
//! Gemini Vision API integration.
//! Two exported functions:
//!   scan_image()       — identify all items in a pile photo
//!   generate_listing() — write an eBay listing for a single item

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

// ── Data types ────────────────────────────────────────────────────────────────
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScannedItem {
    pub name:       String,
    pub confidence: String,   // "High" | "Medium" | "Low"
    pub category:   String,
    pub condition:  String,
    pub notes:      String,
    pub distinguishing_features: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Listing {
    pub title:       String,
    pub description: String,
    pub condition:   String,
    pub category:    String,
    pub price_low:   f64,
    pub price_high:  f64,
    pub price_note:  String,
    pub keywords:    Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScanResult {
    pub items:        Vec<ScannedItem>,
    pub input_tokens:  u32,
    pub output_tokens: u32,
    pub model:         String,
}

// ── Gemini API structs ────────────────────────────────────────────────────────
#[derive(Serialize)]
struct GeminiRequest {
    system_instruction: SystemInstruction,
    contents:           Vec<Content>,
    #[serde(rename = "generationConfig")]
    generation_config:  GenerationConfig,
}

#[derive(Serialize)]
struct SystemInstruction { parts: Vec<TextPart> }

#[derive(Serialize)]
struct Content { role: String, parts: Vec<Part> }

#[derive(Serialize)]
#[serde(untagged)]
enum Part { Text(TextPart), Image(ImagePart) }

#[derive(Serialize)]
struct TextPart { text: String }

#[derive(Serialize)]
struct ImagePart { inline_data: InlineData }

#[derive(Serialize)]
struct InlineData { mime_type: String, data: String }

#[derive(Serialize)]
struct GenerationConfig {
    #[serde(rename = "maxOutputTokens")]
    max_output_tokens: u32,
    temperature: f32,
}

#[derive(Deserialize, Default)]
struct UsageMetadata {
    #[serde(rename = "promptTokenCount", default)]
    prompt_token_count: u32,
    #[serde(rename = "candidatesTokenCount", default)]
    candidates_token_count: u32,
}

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Vec<Candidate>,
    #[serde(rename = "usageMetadata", default)]
    usage_metadata: UsageMetadata,
}

#[derive(Deserialize)]
struct Candidate { content: CandidateContent }

#[derive(Deserialize)]
struct CandidateContent { parts: Vec<ResponsePart> }

#[derive(Deserialize)]
struct ResponsePart { text: Option<String> }

// ── Helpers ───────────────────────────────────────────────────────────────────
fn mime_type(path: &str) -> &'static str {
    match Path::new(path).extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png"          => "image/png",
        "webp"         => "image/webp",
        "heic"         => "image/heic",
        _              => "image/jpeg",
    }
}

fn image_part(path: &str) -> Result<Part, String> {
    let bytes = fs::read(path).map_err(|e| format!("Cannot read {}: {}", path, e))?;
    Ok(Part::Image(ImagePart {
        inline_data: InlineData {
            mime_type: mime_type(path).to_string(),
            data:      B64.encode(&bytes),
        },
    }))
}

fn clean_json(text: &str) -> String {
    let text = text.trim();
    let text = text.strip_prefix("```json").unwrap_or(text);
    let text = text.strip_prefix("```").unwrap_or(text);
    let text = text.strip_suffix("```").unwrap_or(text);
    text.trim().to_string()
}

async fn gemini_call(
    api_key: &str,
    model:   &str,
    system:  &str,
    parts:   Vec<Part>,
) -> Result<(String, u32, u32), String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model, api_key
    );

    let body = GeminiRequest {
        system_instruction: SystemInstruction {
            parts: vec![TextPart { text: system.to_string() }],
        },
        contents: vec![Content { role: "user".to_string(), parts }],
        generation_config: GenerationConfig {
            max_output_tokens: 8192,
            temperature: 0.1,
        },
    };

    let resp = client.post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text   = resp.text().await.unwrap_or_default();
        return Err(format!("Gemini API {} — {}", status, text));
    }

    let data: GeminiResponse = resp.json().await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let text = data.candidates.into_iter()
        .next()
        .and_then(|c| c.content.parts.into_iter().next())
        .and_then(|p| p.text)
        .ok_or_else(|| "Empty response from Gemini".to_string())?;

    Ok((
        text,
        data.usage_metadata.prompt_token_count,
        data.usage_metadata.candidates_token_count,
    ))
}

// ── Default scan prompt ───────────────────────────────────────────────────────
// Stored as a constant so it can be returned to the frontend for display/editing
pub const DEFAULT_SCAN_PROMPT: &str = r#"You are an expert cataloguer of physical items — electronics, IT hardware, tools, household goods, clothing, books, collectibles, and anything else people store in boxes, shelves, garages, or drawers.

Analyse the image carefully. Identify EVERY distinct physical object visible, even partially hidden ones.

For IT hardware and electronics, identify brand, model, generation, and port configuration where visible.
For other items, identify brand, type, colour, size, and any visible markings.

Return ONLY a valid JSON object — no markdown, no explanation:
{
  "items": [
    {
      "name": "string — as specific as possible e.g. Cisco Catalyst 2960 24-Port Switch",
      "category": "string — e.g. Networking, Laptop, Cable, Tool, Book, Clothing",
      "confidence": "High | Medium | Low",
      "condition": "new | like_new | good | fair | poor | unknown",
      "notes": "string — condition details, visible damage, missing parts, colour",
      "distinguishing_features": "string — ports, labels, model numbers, unique markings"
    }
  ]
}"#;

// ── scan_image ────────────────────────────────────────────────────────────────
pub async fn scan_image(
    image_path:    &str,
    api_key:       &str,
    model:         &str,
    custom_prompt: Option<&str>,
) -> Result<ScanResult, String> {
    if !Path::new(image_path).exists() {
        return Err(format!("Image not found: {}", image_path));
    }

    let prompt = custom_prompt.unwrap_or(DEFAULT_SCAN_PROMPT);
    let parts  = vec![
        image_part(image_path)?,
        Part::Text(TextPart { text: "Identify every distinct item in this image. Return the JSON object only.".to_string() }),
    ];

    let (text, input_tokens, output_tokens) = gemini_call(api_key, model, prompt, parts).await?;
    let clean = clean_json(&text);

    // Parse — handle both {items:[]} and plain []
    let value: serde_json::Value = serde_json::from_str(&clean)
        .map_err(|e| format!("JSON parse error: {} — raw: {}", e, &clean[..clean.len().min(200)]))?;

    let arr = if value.is_array() {
        value
    } else {
        value.get("items")
            .or_else(|| value.get("results"))
            .or_else(|| value.get("objects"))
            .cloned()
            .unwrap_or(serde_json::Value::Array(vec![]))
    };

    let raw_items: Vec<serde_json::Value> = serde_json::from_value(arr)
        .map_err(|e| format!("Failed to parse items array: {}", e))?;

    let items = raw_items.into_iter().map(|v| ScannedItem {
        name:       v["name"].as_str().unwrap_or("Unknown item").to_string(),
        confidence: v["confidence"].as_str().unwrap_or("Medium").to_string(),
        category:   v["category"].as_str().unwrap_or("other").to_string(),
        condition:  v["condition"].as_str().unwrap_or("unknown").to_string(),
        notes:      v["notes"].as_str().unwrap_or("").to_string(),
        distinguishing_features: v["distinguishing_features"].as_str().map(String::from),
    }).collect();

    Ok(ScanResult { items, input_tokens, output_tokens, model: model.to_string() })
}

// ── generate_listing ──────────────────────────────────────────────────────────
// This prompt is stored as a constant and shown/editable in Settings → eBay Prompt
pub const DEFAULT_LISTING_PROMPT: &str = r#"You are an expert second-hand marketplace seller specialising in IT hardware, electronics, tools, and general household goods.

Analyse the item details and any photos provided. Write a compelling, accurate eBay listing that will attract buyers and achieve the best price.

Rules:
- Title must be max 80 characters, front-loaded with the most searchable keywords (brand, model, key spec)
- Description must be honest about condition — buyers trust accurate descriptions and leave better feedback
- Price estimate must be based on real eBay sold listings for this item in this condition
- For IT hardware: include key specs (RAM, storage, ports, generation) buyers search for
- For general items: include brand, colour, size, and any defects clearly

Return ONLY valid JSON — no markdown, no explanation:
{
  "title": "string — max 80 chars, e.g. Dell Latitude E7450 i5-5300U 8GB 256GB SSD Laptop",
  "description": "string — 150-300 words, honest condition report, key specs, what's included",
  "condition": "string — one of: New | Like New | Good | Acceptable | For parts or not working",
  "category": "string — eBay category e.g. Laptops & Netbooks, Networking, Hand Tools",
  "price_low": number,
  "price_high": number,
  "price_note": "string — one sentence: why this price range, based on condition and market",
  "keywords": ["array", "5-10", "search", "terms", "buyers", "would", "use"]
}"#;

const LISTING_SYSTEM: &str = DEFAULT_LISTING_PROMPT;

pub fn default_listing_prompt() -> &'static str {
    DEFAULT_LISTING_PROMPT
}

pub async fn generate_listing(
    item_name:   &str,
    item_cond:   &str,
    item_notes:  &str,
    photo_paths: &[String],
    api_key:     &str,
    model:       &str,
) -> Result<Listing, String> {
    let mut parts: Vec<Part> = photo_paths.iter()
        .take(5)
        .filter(|p| Path::new(p.as_str()).exists())
        .filter_map(|p| image_part(p).ok())
        .collect();

    let context = format!(
        "Item: {}\nCondition: {}\nNotes: {}",
        item_name, item_cond, item_notes
    );
    parts.push(Part::Text(TextPart {
        text: format!("{}\n\nGenerate a complete eBay listing. Return JSON only.", context),
    }));

    let (text, _, _) = gemini_call(api_key, model, LISTING_SYSTEM, parts).await?;
    let clean = clean_json(&text);
    serde_json::from_str(&clean).map_err(|e| format!("Failed to parse listing: {}", e))
}

/// Returns the default scan prompt for display in settings
pub fn default_scan_prompt() -> &'static str {
    DEFAULT_SCAN_PROMPT
}
