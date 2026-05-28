//! burrowstock — db.rs
//!
//! SQLite database layer using rusqlite (bundled — no system SQLite needed).
//!
//! Schema mirrors the Electron version exactly so existing databases
//! can be migrated without data loss.
//!
//! All functions return Result<T, DbError> — the command layer converts
//! these to strings for the frontend.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use thiserror::Error;

// ── Error type ────────────────────────────────────────────────────────────────
#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum DbError {
    #[error("Database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0}")]
    Logic(String),
}

// ── Shared state ──────────────────────────────────────────────────────────────
pub struct DbState(pub Mutex<Connection>);

// ── Data types ────────────────────────────────────────────────────────────────
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Location {
    pub id:         String,
    pub label:      String,
    pub location:   String,
    pub item_count: i64,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Item {
    pub id:               i64,
    pub location_id:      String,
    pub scan_id:          Option<i64>,
    pub name:             String,
    pub category:         String,
    pub confidence:       i64,
    pub condition:        String,
    pub notes:            String,
    pub thumb_path:       Option<String>,
    pub item_photo:       Option<String>,
    pub added_at:         i64,
    pub ebay_title:       Option<String>,
    pub ebay_description: Option<String>,
    pub ebay_price:       Option<f64>,
    pub ebay_estimate:    Option<String>,
    pub listing_id:       Option<String>,
    pub location_label:   Option<String>,
    pub scan_image:       Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct NewItem {
    pub name:        String,
    pub category:    Option<String>,
    pub confidence:  Option<i64>,
    pub condition:   Option<String>,
    pub notes:       Option<String>,
    pub thumb_path:  Option<String>,
    pub location:    Option<String>, // used during scan result saving
}

#[derive(Debug, Deserialize)]
pub struct ItemUpdate {
    pub name:             Option<String>,
    pub category:         Option<String>,
    pub condition:        Option<String>,
    pub notes:            Option<String>,
    pub item_photo:       Option<String>,
    pub ebay_title:       Option<String>,
    pub ebay_description: Option<String>,
    pub ebay_price:       Option<f64>,
    pub ebay_estimate:    Option<String>,
}

// ── Init + migrate ────────────────────────────────────────────────────────────
pub fn open(path: &str) -> Result<Connection, DbError> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), DbError> {
    // Migrate old 'boxes' table if it exists
    let has_boxes: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='boxes'",
        [],
        |r| r.get::<_, i64>(0),
    )? > 0;

    let has_locations: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='locations'",
        [],
        |r| r.get::<_, i64>(0),
    )? > 0;

    if has_boxes && !has_locations {
        conn.execute_batch("ALTER TABLE boxes RENAME TO locations;")?;
        // Recreate items with location_id if needed
        let has_box_id: bool = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('items') WHERE name='box_id'",
            [],
            |r| r.get::<_, i64>(0),
        ).unwrap_or(0) > 0;

        if has_box_id {
            conn.execute_batch("
                CREATE TABLE items_new AS SELECT * FROM items;
                DROP TABLE items;
            ")?;
            // Will be recreated below
        }
    }

    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS locations (
            id         TEXT PRIMARY KEY,
            label      TEXT NOT NULL DEFAULT '',
            location   TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS scans (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            image_path TEXT    NOT NULL,
            provider   TEXT    NOT NULL DEFAULT 'gemini',
            model      TEXT    NOT NULL DEFAULT 'gemini-2.5-flash',
            scanned_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS items (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            location_id      TEXT    NOT NULL REFERENCES locations(id) ON UPDATE CASCADE,
            scan_id          INTEGER REFERENCES scans(id),
            name             TEXT    NOT NULL,
            category         TEXT    NOT NULL DEFAULT 'other',
            confidence       INTEGER NOT NULL DEFAULT 50,
            condition        TEXT    NOT NULL DEFAULT 'unknown',
            notes            TEXT    NOT NULL DEFAULT '',
            thumb_path       TEXT,
            item_photo       TEXT,
            added_at         INTEGER NOT NULL DEFAULT (unixepoch()),
            ebay_title       TEXT,
            ebay_description TEXT,
            ebay_price       REAL,
            ebay_estimate    TEXT,
            listing_id       TEXT,
            listed_at        INTEGER,
            sold_at          INTEGER,
            sale_price       INTEGER
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
            name, notes,
            content='items',
            content_rowid='id'
        );

        CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
            INSERT INTO items_fts(rowid, name, notes) VALUES (new.id, new.name, new.notes);
        END;
        CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
            INSERT INTO items_fts(items_fts, rowid, name, notes)
            VALUES ('delete', old.id, old.name, old.notes);
        END;
        CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
            INSERT INTO items_fts(items_fts, rowid, name, notes)
            VALUES ('delete', old.id, old.name, old.notes);
            INSERT INTO items_fts(rowid, name, notes) VALUES (new.id, new.name, new.notes);
        END;
    ")?;

    // Migrate items_new if it exists from the box_id rename
    let has_items_new: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='items_new'",
        [],
        |r| r.get::<_, i64>(0),
    )? > 0;

    if has_items_new {
        conn.execute_batch("
            INSERT INTO items (id, location_id, scan_id, name, category,
                             confidence, notes, thumb_path, added_at)
            SELECT id, box_id, scan_id, name, category,
                   confidence, notes, thumb_path, added_at
            FROM items_new;
            DROP TABLE items_new;
        ")?;
    }

    Ok(())
}

// ── Locations ─────────────────────────────────────────────────────────────────
pub fn list_locations(conn: &Connection) -> Result<Vec<Location>, DbError> {
    let mut stmt = conn.prepare("
        SELECT l.id, l.label, l.location, l.created_at,
               COUNT(i.id) AS item_count
        FROM locations l
        LEFT JOIN items i ON i.location_id = l.id
        GROUP BY l.id
        ORDER BY l.id
    ")?;
    let rows = stmt.query_map([], |r| Ok(Location {
        id:         r.get(0)?,
        label:      r.get(1)?,
        location:   r.get(2)?,
        created_at: r.get(3)?,
        item_count: r.get(4)?,
    }))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn upsert_location(conn: &Connection, id: &str, label: &str) -> Result<(), DbError> {
    conn.execute("
        INSERT INTO locations (id, label)
        VALUES (?1, ?2)
        ON CONFLICT(id) DO UPDATE SET label=excluded.label
    ", params![id, label])?;
    Ok(())
}

pub fn rename_location(conn: &Connection, old_id: &str, new_id: &str) -> Result<(), DbError> {
    // Disable FK checks temporarily so we can repoint items before deleting old location
    conn.pragma_update(None, "foreign_keys", "OFF")?;

    let result = (|| -> Result<(), DbError> {
        // 1. Insert new location copying from old
        conn.execute("
            INSERT INTO locations (id, label, location, created_at)
            SELECT ?1, label, location, created_at FROM locations WHERE id=?2
        ", params![new_id, old_id])?;

        // 2. Repoint all items to new location
        conn.execute(
            "UPDATE items SET location_id=?1 WHERE location_id=?2",
            params![new_id, old_id]
        )?;

        // 3. Delete old location
        conn.execute("DELETE FROM locations WHERE id=?1", params![old_id])?;

        Ok(())
    })();

    // Re-enable FK checks regardless of outcome
    conn.pragma_update(None, "foreign_keys", "ON")?;

    result
}

pub fn delete_location(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    let result = (|| -> Result<(), DbError> {
        conn.execute("DELETE FROM items WHERE location_id=?1", params![id])?;
        conn.execute("DELETE FROM locations WHERE id=?1", params![id])?;
        Ok(())
    })();
    conn.pragma_update(None, "foreign_keys", "ON")?;
    result
}

// ── Items ─────────────────────────────────────────────────────────────────────
fn item_from_row(r: &rusqlite::Row) -> rusqlite::Result<Item> {
    Ok(Item {
        id:               r.get(0)?,
        location_id:      r.get(1)?,
        scan_id:          r.get(2)?,
        name:             r.get(3)?,
        category:         r.get(4)?,
        confidence:       r.get(5)?,
        condition:        r.get(6)?,
        notes:            r.get(7)?,
        thumb_path:       r.get(8)?,
        item_photo:       r.get(9)?,
        added_at:         r.get(10)?,
        ebay_title:       r.get(11)?,
        ebay_description: r.get(12)?,
        ebay_price:       r.get(13)?,
        ebay_estimate:    r.get(14)?,
        listing_id:       r.get(15)?,
        location_label:   r.get(16).ok(),
        scan_image:       r.get(17).ok(),
    })
}

pub fn list_items(conn: &Connection, location_id: Option<&str>) -> Result<Vec<Item>, DbError> {
    let sql = "
        SELECT i.id, i.location_id, i.scan_id, i.name, i.category, i.confidence,
               i.condition, i.notes, i.thumb_path, i.item_photo, i.added_at,
               i.ebay_title, i.ebay_description, i.ebay_price, i.ebay_estimate,
               i.listing_id, l.label, s.image_path
        FROM items i
        JOIN locations l ON l.id = i.location_id
        LEFT JOIN scans s ON s.id = i.scan_id
        WHERE (?1 IS NULL OR i.location_id = ?1)
        ORDER BY i.added_at DESC
    ";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![location_id], item_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_item(conn: &Connection, id: i64) -> Result<Item, DbError> {
    let sql = "
        SELECT i.id, i.location_id, i.scan_id, i.name, i.category, i.confidence,
               i.condition, i.notes, i.thumb_path, i.item_photo, i.added_at,
               i.ebay_title, i.ebay_description, i.ebay_price, i.ebay_estimate,
               i.listing_id, l.label, s.image_path
        FROM items i
        JOIN locations l ON l.id = i.location_id
        LEFT JOIN scans s ON s.id = i.scan_id
        WHERE i.id = ?1
    ";
    Ok(conn.query_row(sql, params![id], item_from_row)?)
}

pub fn add_item(
    conn: &Connection,
    location_id: &str,
    scan_id: Option<i64>,
    name: &str,
    category: &str,
    confidence: i64,
    condition: &str,
    notes: &str,
) -> Result<i64, DbError> {
    conn.execute("
        INSERT INTO items (location_id, scan_id, name, category, confidence, condition, notes)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ", params![location_id, scan_id, name, category, confidence, condition, notes])?;
    Ok(conn.last_insert_rowid())
}

pub fn update_item(conn: &Connection, id: i64, update: &ItemUpdate) -> Result<(), DbError> {
    if let Some(v) = &update.name             { conn.execute("UPDATE items SET name=?1 WHERE id=?2",             params![v, id])?; }
    if let Some(v) = &update.category         { conn.execute("UPDATE items SET category=?1 WHERE id=?2",         params![v, id])?; }
    if let Some(v) = &update.condition        { conn.execute("UPDATE items SET condition=?1 WHERE id=?2",         params![v, id])?; }
    if let Some(v) = &update.notes            { conn.execute("UPDATE items SET notes=?1 WHERE id=?2",            params![v, id])?; }
    if let Some(v) = &update.item_photo       { conn.execute("UPDATE items SET item_photo=?1 WHERE id=?2",       params![v, id])?; }
    if let Some(v) = &update.ebay_title       { conn.execute("UPDATE items SET ebay_title=?1 WHERE id=?2",       params![v, id])?; }
    if let Some(v) = &update.ebay_description { conn.execute("UPDATE items SET ebay_description=?1 WHERE id=?2", params![v, id])?; }
    if let Some(v) = &update.ebay_price       { conn.execute("UPDATE items SET ebay_price=?1 WHERE id=?2",       params![v, id])?; }
    if let Some(v) = &update.ebay_estimate    { conn.execute("UPDATE items SET ebay_estimate=?1 WHERE id=?2",    params![v, id])?; }
    Ok(())
}

pub fn delete_item(conn: &Connection, id: i64) -> Result<(), DbError> {
    conn.execute("DELETE FROM items WHERE id=?1", params![id])?;
    Ok(())
}

pub fn move_item(conn: &Connection, id: i64, location_id: &str) -> Result<(), DbError> {
    conn.execute("UPDATE items SET location_id=?1 WHERE id=?2", params![location_id, id])?;
    Ok(())
}

pub fn search_items(conn: &Connection, query: &str) -> Result<Vec<Item>, DbError> {
    if query.trim().is_empty() { return Ok(vec![]); }
    let pattern = format!("{}*", query.trim());
    let sql = "
        SELECT i.id, i.location_id, i.scan_id, i.name, i.category, i.confidence,
               i.condition, i.notes, i.thumb_path, i.item_photo, i.added_at,
               i.ebay_title, i.ebay_description, i.ebay_price, i.ebay_estimate,
               i.listing_id, l.label, s.image_path
        FROM items_fts
        JOIN items i ON items_fts.rowid = i.id
        JOIN locations l ON l.id = i.location_id
        LEFT JOIN scans s ON s.id = i.scan_id
        WHERE items_fts MATCH ?1
        ORDER BY rank
        LIMIT 50
    ";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![pattern], item_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

// ── Scans ─────────────────────────────────────────────────────────────────────
pub fn insert_scan(conn: &Connection, image_path: &str, model: &str) -> Result<i64, DbError> {
    conn.execute("
        INSERT INTO scans (image_path, provider, model)
        VALUES (?1, 'gemini', ?2)
    ", params![image_path, model])?;
    Ok(conn.last_insert_rowid())
}
