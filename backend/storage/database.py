"""
Inicialización y gestión de la base de datos SQLite para Diario Inteligente.
Garantiza transacciones seguras (WAL mode), aislamiento por usuario y
almacenamiento 100% local-first.
"""

import os
import sqlite3
from contextlib import contextmanager
from typing import Iterator
from backend.config import DB_PATH

SCHEMA_VERSION = 2


def get_connection() -> sqlite3.Connection:
    """Retorna una conexión a SQLite configurada con UTF-8, timeout y llaves foráneas."""
    conn = sqlite3.connect(str(DB_PATH), timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    return conn


@contextmanager
def db_connection(commit: bool = False) -> Iterator[sqlite3.Connection]:
    """Context manager seguro para conexiones SQLite: confirma/revierte y siempre cierra."""
    conn = get_connection()
    try:
        yield conn
        if commit:
            conn.commit()
    except Exception:
        if commit:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
        raise
    finally:
        conn.close()


def _table_sql(cursor: sqlite3.Cursor, table: str) -> str:
    row = cursor.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    return (row[0] or "") if row else ""


def _columns(cursor: sqlite3.Cursor, table: str) -> set:
    try:
        return {row[1] for row in cursor.execute(f"PRAGMA table_info({table})")}
    except sqlite3.OperationalError:
        return set()


def _has_user_column(cursor: sqlite3.Cursor, table: str) -> bool:
    return "user_id" in _columns(cursor, table)


def _add_user_column(cursor: sqlite3.Cursor, table: str) -> None:
    if not _has_user_column(cursor, table):
        cursor.execute(
            f"ALTER TABLE {table} ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0"
        )


def _create_tables(cursor: sqlite3.Cursor) -> None:
    cursor.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL COLLATE NOCASE UNIQUE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
            is_active INTEGER NOT NULL DEFAULT 1,
            must_change_password INTEGER NOT NULL DEFAULT 0,
            failed_attempts INTEGER NOT NULL DEFAULT 0,
            locked_until TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_login_at TEXT
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            ip TEXT,
            user_agent TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

        CREATE TABLE IF NOT EXISTS quick_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS day_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            date TEXT NOT NULL,
            day_text TEXT DEFAULT '',
            questionnaire_json TEXT NOT NULL,
            laya_profile_json TEXT,
            discrepancy_json TEXT,
            safety_json TEXT,
            goal_alignment_json TEXT,
            user_corrections_json TEXT DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (user_id, date)
        );

        CREATE TABLE IF NOT EXISTS user_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            date TEXT NOT NULL,
            text_snippet TEXT NOT NULL,
            question_id TEXT NOT NULL,
            original_value TEXT NOT NULL,
            corrected_value TEXT NOT NULL,
            notes TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_profile (
            user_id INTEGER PRIMARY KEY,
            profile_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS self_assessments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            quiz_id TEXT NOT NULL,
            quiz_title TEXT NOT NULL,
            data_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS learning_progress (
            user_id INTEGER NOT NULL DEFAULT 0,
            lesson_id TEXT NOT NULL,
            track_id TEXT NOT NULL,
            completed_at TEXT NOT NULL,
            best_accuracy REAL DEFAULT 0,
            attempts INTEGER DEFAULT 0,
            exp_earned INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, lesson_id)
        );

        CREATE TABLE IF NOT EXISTS hlr_memory (
            user_id INTEGER NOT NULL DEFAULT 0,
            lesson_id TEXT NOT NULL,
            half_life_days REAL DEFAULT 4.0,
            last_reviewed_at TEXT NOT NULL,
            PRIMARY KEY (user_id, lesson_id)
        );

        CREATE TABLE IF NOT EXISTS therapy_notebook (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            track_title TEXT NOT NULL,
            lesson_id TEXT NOT NULL,
            statement_text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            exported INTEGER DEFAULT 0
        );
        """
    )


def _migrate_legacy_tables(cursor: sqlite3.Cursor) -> None:
    """Migra bases de datos de una sola persona a un esquema multi-usuario.

    Todas las filas existentes quedan con user_id = 0 (datos heredados).
    El primer usuario que se registra los adopta (ver auth.adopt_legacy_data).
    """
    # 1. day_entries: date UNIQUE -> UNIQUE(user_id, date)
    sql = _table_sql(cursor, "day_entries")
    if sql and (not _has_user_column(cursor, "day_entries") or "date TEXT UNIQUE" in sql):
        cols = _columns(cursor, "day_entries")

        def expr(col: str, fallback: str = "NULL") -> str:
            return col if col in cols else fallback

        cursor.execute("ALTER TABLE day_entries RENAME TO day_entries_legacy")
        cursor.execute(
            """
            CREATE TABLE day_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL DEFAULT 0,
                date TEXT NOT NULL,
                day_text TEXT DEFAULT '',
                questionnaire_json TEXT NOT NULL,
                laya_profile_json TEXT,
                discrepancy_json TEXT,
                safety_json TEXT,
                goal_alignment_json TEXT,
                user_corrections_json TEXT DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE (user_id, date)
            )
            """
        )
        cursor.execute(
            f"""
            INSERT INTO day_entries
                (id, user_id, date, day_text, questionnaire_json, laya_profile_json,
                 discrepancy_json, safety_json, goal_alignment_json,
                 user_corrections_json, created_at, updated_at)
            SELECT id, 0, date, {expr('day_text', "''")}, {expr('questionnaire_json', "'{}'")},
                   {expr('laya_profile_json')}, {expr('discrepancy_json')},
                   {expr('safety_json')}, {expr('goal_alignment_json')},
                   {expr('user_corrections_json', "'{}'")},
                   {expr('created_at', "datetime('now')")}, {expr('updated_at', "datetime('now')")}
            FROM day_entries_legacy
            """
        )
        cursor.execute("DROP TABLE day_entries_legacy")

    # 2. user_profile: id = 1 -> user_id
    sql = _table_sql(cursor, "user_profile")
    if sql and (not _has_user_column(cursor, "user_profile") or "CHECK (id = 1)" in sql):
        cols = _columns(cursor, "user_profile")
        cursor.execute("ALTER TABLE user_profile RENAME TO user_profile_legacy")
        cursor.execute(
            """
            CREATE TABLE user_profile (
                user_id INTEGER PRIMARY KEY,
                profile_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        if "profile_json" in cols:
            cursor.execute(
                """
                INSERT INTO user_profile (user_id, profile_json, created_at, updated_at)
                SELECT 0, profile_json, created_at, updated_at FROM user_profile_legacy
                """
            )
        cursor.execute("DROP TABLE user_profile_legacy")

    # 3. learning_progress: lesson_id PK -> (user_id, lesson_id)
    sql = _table_sql(cursor, "learning_progress")
    if sql and (not _has_user_column(cursor, "learning_progress") or "lesson_id TEXT PRIMARY KEY" in sql):
        cols = _columns(cursor, "learning_progress")
        cursor.execute("ALTER TABLE learning_progress RENAME TO learning_progress_legacy")
        cursor.execute(
            """
            CREATE TABLE learning_progress (
                user_id INTEGER NOT NULL DEFAULT 0,
                lesson_id TEXT NOT NULL,
                track_id TEXT NOT NULL,
                completed_at TEXT NOT NULL,
                best_accuracy REAL DEFAULT 0,
                attempts INTEGER DEFAULT 0,
                exp_earned INTEGER DEFAULT 0,
                PRIMARY KEY (user_id, lesson_id)
            )
            """
        )
        if "lesson_id" in cols:
            cursor.execute(
                """
                INSERT INTO learning_progress
                    (user_id, lesson_id, track_id, completed_at, best_accuracy, attempts, exp_earned)
                SELECT 0, lesson_id, track_id, completed_at, best_accuracy, attempts, exp_earned
                FROM learning_progress_legacy
                """
            )
        cursor.execute("DROP TABLE learning_progress_legacy")

    # 4. hlr_memory: lesson_id PK -> (user_id, lesson_id)
    sql = _table_sql(cursor, "hlr_memory")
    if sql and (not _has_user_column(cursor, "hlr_memory") or "lesson_id TEXT PRIMARY KEY" in sql):
        cols = _columns(cursor, "hlr_memory")
        cursor.execute("ALTER TABLE hlr_memory RENAME TO hlr_memory_legacy")
        cursor.execute(
            """
            CREATE TABLE hlr_memory (
                user_id INTEGER NOT NULL DEFAULT 0,
                lesson_id TEXT NOT NULL,
                half_life_days REAL DEFAULT 4.0,
                last_reviewed_at TEXT NOT NULL,
                PRIMARY KEY (user_id, lesson_id)
            )
            """
        )
        if "lesson_id" in cols:
            cursor.execute(
                """
                INSERT INTO hlr_memory (user_id, lesson_id, half_life_days, last_reviewed_at)
                SELECT 0, lesson_id, half_life_days, last_reviewed_at FROM hlr_memory_legacy
                """
            )
        cursor.execute("DROP TABLE hlr_memory_legacy")

    # 5. Tablas sin claves únicas compuestas: solo agregar user_id.
    for table in ("quick_notes", "user_feedback", "self_assessments", "therapy_notebook"):
        if _table_sql(cursor, table):
            _add_user_column(cursor, table)


def _create_indexes(cursor: sqlite3.Cursor) -> None:
    cursor.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_quick_notes_user_date ON quick_notes(user_id, date);
        CREATE INDEX IF NOT EXISTS idx_day_entries_user_date ON day_entries(user_id, date);
        CREATE INDEX IF NOT EXISTS idx_self_assessments_user ON self_assessments(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_therapy_notebook_user ON therapy_notebook(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_user_feedback_user ON user_feedback(user_id, created_at);
        """
    )


def init_db() -> None:
    """Crea o migra las tablas necesarias. Idempotente."""
    with db_connection(commit=True) as conn:
        conn.execute("PRAGMA journal_mode = WAL;")
        cursor = conn.cursor()
        _create_tables(cursor)
        _migrate_legacy_tables(cursor)
        _create_indexes(cursor)
        cursor.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    # El diario es privado: solo el usuario del sistema debe poder leerlo.
    for suffix in ("", "-wal", "-shm"):
        try:
            os.chmod(f"{DB_PATH}{suffix}", 0o600)
        except OSError:
            pass


if __name__ == "__main__":
    init_db()
    print("Database initialized successfully at", DB_PATH)
