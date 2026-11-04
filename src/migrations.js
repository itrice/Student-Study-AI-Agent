import { createHash } from "node:crypto";

const BASELINE_KNOWLEDGE_POINTS = [
  "分数乘除法",
  "比和比例",
  "百分数",
  "圆",
  "圆柱与圆锥",
  "负数",
  "统计与扇形统计图",
  "比例与图形",
  "综合应用"
];

const BASELINE_STUDENT = {
  name: "六年级同学",
  grade: 6
};

export const BASELINE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    grade INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mistakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    student_answer TEXT NOT NULL DEFAULT '',
    correct_answer TEXT NOT NULL,
    analysis TEXT NOT NULL DEFAULT '',
    knowledge_point TEXT NOT NULL,
    error_type TEXT NOT NULL,
    hint TEXT NOT NULL,
    method_steps TEXT NOT NULL DEFAULT '[]',
    common_errors TEXT NOT NULL DEFAULT '[]',
    diagnosis TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    consecutive_correct INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    due_at TEXT,
    last_reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(student_id) REFERENCES students(id)
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id INTEGER NOT NULL,
    answer TEXT NOT NULL,
    is_correct INTEGER NOT NULL,
    feedback TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mistakes_due
  ON mistakes(status, due_at);

  CREATE INDEX IF NOT EXISTS idx_attempts_mistake_id
  ON attempts(mistake_id, created_at);
`;

const REQUIRED_COLUMNS = {
  students: ["id", "name", "grade", "created_at"],
  knowledge_points: ["id", "name", "position"],
  mistakes: [
    "id",
    "student_id",
    "question",
    "student_answer",
    "correct_answer",
    "analysis",
    "knowledge_point",
    "error_type",
    "hint",
    "method_steps",
    "common_errors",
    "diagnosis",
    "status",
    "consecutive_correct",
    "attempt_count",
    "due_at",
    "last_reviewed_at",
    "created_at",
    "updated_at"
  ],
  attempts: [
    "id",
    "mistake_id",
    "answer",
    "is_correct",
    "feedback",
    "created_at"
  ]
};

function assertRequiredColumns(db, table, requiredColumns) {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all();
  if (!rows.length) {
    throw new Error(`数据库迁移失败：缺少 ${table} 表`);
  }

  const actualColumns = new Set(rows.map((row) => row.name));
  const missingColumns = requiredColumns.filter(
    (column) => !actualColumns.has(column)
  );
  if (missingColumns.length) {
    throw new Error(
      `数据库迁移失败：${table} 表缺少字段 ${missingColumns.join(", ")}`
    );
  }
}

function seedBaselineData(db) {
  const studentCount = db
    .prepare("SELECT COUNT(*) AS count FROM students")
    .get().count;
  if (!studentCount) {
    db.prepare(
      "INSERT INTO students (name, grade, created_at) VALUES (?, ?, ?)"
    ).run(
      BASELINE_STUDENT.name,
      BASELINE_STUDENT.grade,
      new Date().toISOString()
    );
  }

  const insertPoint = db.prepare(
    "INSERT OR IGNORE INTO knowledge_points (name, position) VALUES (?, ?)"
  );
  BASELINE_KNOWLEDGE_POINTS.forEach((name, index) => {
    insertPoint.run(name, index);
  });
}

const BASELINE_MIGRATION_CHECKSUM_SOURCE = JSON.stringify({
  schema: BASELINE_SCHEMA_SQL,
  knowledgePoints: BASELINE_KNOWLEDGE_POINTS,
  student: BASELINE_STUDENT
});

export const SCHEMA_MIGRATIONS = [
  {
    version: 1,
    name: "baseline_learning_schema",
    checksumSource: BASELINE_MIGRATION_CHECKSUM_SOURCE,
    up(db) {
      db.exec(BASELINE_SCHEMA_SQL);
      seedBaselineData(db);

      for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
        assertRequiredColumns(db, table, columns);
      }
    }
  }
];

function migrationChecksum(migration) {
  return createHash("sha256")
    .update(
      `${migration.version}\n${migration.name}\n${migration.checksumSource}`
    )
    .digest("hex");
}

function validateMigrationDefinitions(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new Error("至少需要定义一个数据库迁移");
  }

  migrations.forEach((migration, index) => {
    const expectedVersion = index + 1;
    if (
      !Number.isInteger(migration.version) ||
      migration.version !== expectedVersion
    ) {
      throw new Error(
        `数据库迁移版本必须从 1 开始连续编号，期望 ${expectedVersion}`
      );
    }
    if (
      !migration.name ||
      typeof migration.up !== "function" ||
      !migration.checksumSource
    ) {
      throw new Error(
        `数据库迁移 v${migration.version} 缺少名称、校验内容或执行函数`
      );
    }
  });
}

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function getSchemaVersion(db) {
  const table = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get("schema_migrations");
  if (!table) return 0;

  const row = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get();
  return Number(row.version || 0);
}

export function migrateDatabase(
  db,
  { migrations = SCHEMA_MIGRATIONS, beforeMigration } = {}
) {
  validateMigrationDefinitions(migrations);
  const latestVersion = migrations.length;
  const userVersion = Number(
    db.prepare("PRAGMA user_version").get().user_version || 0
  );
  if (userVersion > latestVersion) {
    throw new Error(
      `数据库版本 ${userVersion} 高于当前程序支持的版本 ${latestVersion}`
    );
  }

  ensureMigrationTable(db);
  const appliedRows = db
    .prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
    )
    .all();

  const unknownMigration = appliedRows.find(
    (row) => row.version < 1 || row.version > latestVersion
  );
  if (unknownMigration) {
    throw new Error(
      `数据库包含当前程序无法识别的迁移版本 ${unknownMigration.version}`
    );
  }

  appliedRows.forEach((row, index) => {
    const expectedVersion = index + 1;
    if (Number(row.version) !== expectedVersion) {
      throw new Error("数据库迁移历史不连续");
    }

    const migration = migrations[expectedVersion - 1];
    if (row.name !== migration.name) {
      throw new Error(
        `数据库迁移 v${expectedVersion} 名称与当前程序不一致`
      );
    }
    if (row.checksum !== migrationChecksum(migration)) {
      throw new Error(
        `数据库迁移 v${expectedVersion} 已执行内容被修改，请创建新的迁移`
      );
    }
  });

  const currentVersion = appliedRows.length;
  const pendingMigrations = migrations.slice(currentVersion);
  const appliedVersions = [];
  if (pendingMigrations.length && typeof beforeMigration === "function") {
    beforeMigration({
      currentVersion,
      targetVersion: latestVersion,
      pendingVersions: pendingMigrations.map((migration) => migration.version)
    });
  }

  for (const migration of pendingMigrations) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.prepare(
        `INSERT INTO schema_migrations
         (version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?)`
      ).run(
        migration.version,
        migration.name,
        migrationChecksum(migration),
        new Date().toISOString()
      );
      db.exec("COMMIT");
      appliedVersions.push(migration.version);
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `数据库迁移 v${migration.version}（${migration.name}）执行失败`,
        { cause: error }
      );
    }
  }

  const finalVersion = getSchemaVersion(db);
  db.exec(`PRAGMA user_version = ${finalVersion}`);
  return {
    fromVersion: currentVersion,
    toVersion: finalVersion,
    appliedVersions
  };
}
