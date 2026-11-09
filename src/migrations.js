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

const BASELINE_REQUIRED_COLUMNS = {
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

export const AGENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type TEXT NOT NULL,
    goal TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'created'
      CHECK (status IN ('created', 'in_progress', 'awaiting_user', 'completed', 'failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error_message TEXT
  );

  CREATE TABLE IF NOT EXISTS diagnoses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id INTEGER NOT NULL,
    agent_run_id INTEGER,
    knowledge_point TEXT,
    error_type TEXT,
    error_step TEXT NOT NULL DEFAULT '',
    missing_concept TEXT NOT NULL DEFAULT '',
    initial_hint TEXT NOT NULL DEFAULT '',
    confidence REAL,
    evidence TEXT NOT NULL DEFAULT '',
    knowledge_sources TEXT NOT NULL DEFAULT '[]',
    raw_output TEXT NOT NULL DEFAULT '{}',
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '',
    accepted_by_user INTEGER NOT NULL DEFAULT 0
      CHECK (accepted_by_user IN (0, 1)),
    accepted_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE,
    FOREIGN KEY(agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
  );

  ALTER TABLE attempts ADD COLUMN outcome TEXT
    CHECK (outcome IN ('correct', 'partial', 'incorrect', 'ungraded'));
  ALTER TABLE attempts ADD COLUMN hint_level INTEGER;
  ALTER TABLE attempts ADD COLUMN independent INTEGER
    CHECK (independent IN (0, 1) OR independent IS NULL);
  ALTER TABLE attempts ADD COLUMN evaluation_source TEXT NOT NULL DEFAULT 'legacy_rule';
  ALTER TABLE attempts ADD COLUMN agent_run_id INTEGER
    REFERENCES agent_runs(id) ON DELETE SET NULL;

  UPDATE attempts
  SET outcome = CASE WHEN is_correct = 1 THEN 'correct' ELSE 'incorrect' END
  WHERE outcome IS NULL;

  CREATE TABLE IF NOT EXISTS hint_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id INTEGER NOT NULL,
    attempt_id INTEGER,
    agent_run_id INTEGER,
    hint_level INTEGER NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY(mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE,
    FOREIGN KEY(attempt_id) REFERENCES attempts(id) ON DELETE SET NULL,
    FOREIGN KEY(agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS review_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id INTEGER NOT NULL,
    next_review_at TEXT NOT NULL,
    interval_days INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    rule_version TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    superseded_at TEXT,
    FOREIGN KEY(mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS mastery_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id INTEGER NOT NULL,
    attempt_id INTEGER NOT NULL UNIQUE,
    evidence_type TEXT NOT NULL,
    rule_version TEXT NOT NULL,
    independent INTEGER NOT NULL CHECK (independent IN (0, 1)),
    created_at TEXT NOT NULL,
    FOREIGN KEY(mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE,
    FOREIGN KEY(attempt_id) REFERENCES attempts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    arguments_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    latency_ms INTEGER,
    error_message TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL DEFAULT '',
    input_summary TEXT NOT NULL DEFAULT '',
    output_summary TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_diagnoses_mistake
  ON diagnoses(mistake_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_hint_events_mistake
  ON hint_events(mistake_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_review_schedule_due
  ON review_schedule(active, next_review_at);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_review_schedule_one_active
  ON review_schedule(mistake_id) WHERE active = 1;

  CREATE INDEX IF NOT EXISTS idx_mastery_evidence_mistake
  ON mastery_evidence(mistake_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_agent_runs_status
  ON agent_runs(status, started_at);

  CREATE INDEX IF NOT EXISTS idx_tool_calls_run
  ON tool_calls(run_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_llm_calls_run
  ON llm_calls(run_id, created_at);
`;

const AGENT_SCHEMA_REQUIRED_COLUMNS = {
  agent_runs: [
    "id",
    "task_type",
    "goal",
    "status",
    "started_at",
    "finished_at",
    "error_message"
  ],
  diagnoses: [
    "id",
    "mistake_id",
    "agent_run_id",
    "knowledge_point",
    "error_type",
    "error_step",
    "missing_concept",
    "initial_hint",
    "confidence",
    "evidence",
    "knowledge_sources",
    "raw_output",
    "provider",
    "model",
    "prompt_version",
    "accepted_by_user",
    "accepted_at",
    "created_at"
  ],
  attempts: [
    "outcome",
    "hint_level",
    "independent",
    "evaluation_source",
    "agent_run_id"
  ],
  hint_events: [
    "id",
    "mistake_id",
    "attempt_id",
    "agent_run_id",
    "hint_level",
    "content",
    "source",
    "created_at"
  ],
  review_schedule: [
    "id",
    "mistake_id",
    "next_review_at",
    "interval_days",
    "reason",
    "rule_version",
    "active",
    "created_at",
    "superseded_at"
  ],
  mastery_evidence: [
    "id",
    "mistake_id",
    "attempt_id",
    "evidence_type",
    "rule_version",
    "independent",
    "created_at"
  ],
  tool_calls: [
    "id",
    "run_id",
    "tool_name",
    "arguments_json",
    "result_json",
    "status",
    "latency_ms",
    "error_message",
    "created_at"
  ],
  llm_calls: [
    "id",
    "run_id",
    "provider",
    "model",
    "prompt_version",
    "input_summary",
    "output_summary",
    "input_tokens",
    "output_tokens",
    "latency_ms",
    "status",
    "error_message",
    "created_at"
  ]
};

export const TOOLING_SCHEMA_SQL = `
  ALTER TABLE tool_calls ADD COLUMN idempotency_key TEXT;
  ALTER TABLE tool_calls ADD COLUMN updated_at TEXT;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_idempotency
  ON tool_calls(tool_name, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS mistake_drafts (
    id TEXT PRIMARY KEY,
    student_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    student_answer TEXT NOT NULL DEFAULT '',
    correct_answer TEXT NOT NULL,
    analysis TEXT NOT NULL DEFAULT '',
    knowledge_point TEXT NOT NULL,
    error_type TEXT NOT NULL,
    diagnosis_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft', 'saved', 'expired')),
    saved_mistake_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY(student_id) REFERENCES students(id),
    FOREIGN KEY(saved_mistake_id) REFERENCES mistakes(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_mistake_drafts_status
  ON mistake_drafts(status, expires_at);
`;

const TOOLING_SCHEMA_REQUIRED_COLUMNS = {
  tool_calls: ["idempotency_key", "updated_at"],
  mistake_drafts: [
    "id",
    "student_id",
    "question",
    "student_answer",
    "correct_answer",
    "analysis",
    "knowledge_point",
    "error_type",
    "diagnosis_json",
    "status",
    "saved_mistake_id",
    "created_at",
    "updated_at",
    "expires_at"
  ]
};

export const MISTAKE_EDITING_SCHEMA_SQL = `
  ALTER TABLE mistakes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

  CREATE TABLE IF NOT EXISTS mistake_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id INTEGER NOT NULL,
    revision_before INTEGER NOT NULL,
    revision_after INTEGER NOT NULL,
    changed_fields_json TEXT NOT NULL DEFAULT '[]',
    before_json TEXT NOT NULL DEFAULT '{}',
    after_json TEXT NOT NULL DEFAULT '{}',
    reset_learning INTEGER NOT NULL DEFAULT 0
      CHECK (reset_learning IN (0, 1)),
    edited_at TEXT NOT NULL,
    FOREIGN KEY(mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mistake_edits_mistake
  ON mistake_edits(mistake_id, edited_at);
`;

const MISTAKE_EDITING_SCHEMA_REQUIRED_COLUMNS = {
  mistakes: ["revision"],
  mistake_edits: [
    "id",
    "mistake_id",
    "revision_before",
    "revision_after",
    "changed_fields_json",
    "before_json",
    "after_json",
    "reset_learning",
    "edited_at"
  ]
};

export const MULTI_PART_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS mistake_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id INTEGER NOT NULL,
    part_no INTEGER NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    student_answer TEXT NOT NULL DEFAULT '',
    answer_type TEXT NOT NULL DEFAULT 'auto',
    comparison_rule TEXT NOT NULL DEFAULT 'auto',
    knowledge_point TEXT NOT NULL,
    hint TEXT NOT NULL DEFAULT '',
    explanation TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_mistake_parts_active_no
  ON mistake_parts(mistake_id, part_no)
  WHERE active = 1;

  CREATE TABLE IF NOT EXISTS accepted_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    answer TEXT NOT NULL,
    variant_type TEXT NOT NULL DEFAULT 'expected',
    created_at TEXT NOT NULL,
    FOREIGN KEY(part_id) REFERENCES mistake_parts(id) ON DELETE CASCADE,
    UNIQUE(part_id, position)
  );

  CREATE TABLE IF NOT EXISTS attempt_part_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL,
    part_id INTEGER NOT NULL,
    raw_answer TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL
      CHECK (outcome IN ('correct', 'partial', 'incorrect', 'ungraded')),
    feedback TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY(attempt_id) REFERENCES attempts(id) ON DELETE CASCADE,
    FOREIGN KEY(part_id) REFERENCES mistake_parts(id) ON DELETE CASCADE,
    UNIQUE(attempt_id, part_id)
  );

  ALTER TABLE mistake_drafts
  ADD COLUMN parts_json TEXT NOT NULL DEFAULT '[]';

  ALTER TABLE hint_events
  ADD COLUMN part_id INTEGER REFERENCES mistake_parts(id) ON DELETE SET NULL;

  INSERT INTO mistake_parts (
    mistake_id, part_no, label, prompt, student_answer, answer_type,
    comparison_rule, knowledge_point, hint, explanation, active,
    created_at, updated_at
  )
  SELECT
    m.id, 1, '', '', m.student_answer, 'auto', 'auto',
    m.knowledge_point, m.hint, m.diagnosis, 1, m.created_at, m.updated_at
  FROM mistakes m
  WHERE NOT EXISTS (
    SELECT 1 FROM mistake_parts p WHERE p.mistake_id = m.id
  );

  INSERT INTO accepted_answers (
    part_id, position, answer, variant_type, created_at
  )
  SELECT
    p.id, 1, m.correct_answer, 'legacy', m.created_at
  FROM mistake_parts p
  JOIN mistakes m ON m.id = p.mistake_id
  WHERE p.part_no = 1
    AND NOT EXISTS (
      SELECT 1 FROM accepted_answers a WHERE a.part_id = p.id
    );

  INSERT INTO attempt_part_results (
    attempt_id, part_id, raw_answer, outcome, feedback, created_at
  )
  SELECT
    a.id, p.id, a.answer,
    CASE WHEN a.is_correct = 1 THEN 'correct' ELSE 'incorrect' END,
    a.feedback, a.created_at
  FROM attempts a
  JOIN mistake_parts p ON p.mistake_id = a.mistake_id AND p.part_no = 1
  WHERE NOT EXISTS (
    SELECT 1 FROM attempt_part_results r
    WHERE r.attempt_id = a.id AND r.part_id = p.id
  );

  CREATE INDEX IF NOT EXISTS idx_accepted_answers_part
  ON accepted_answers(part_id, position);

  CREATE INDEX IF NOT EXISTS idx_attempt_part_results_attempt
  ON attempt_part_results(attempt_id);
`;

const MULTI_PART_SCHEMA_REQUIRED_COLUMNS = {
  mistake_parts: [
    "id",
    "mistake_id",
    "part_no",
    "label",
    "prompt",
    "student_answer",
    "answer_type",
    "comparison_rule",
    "knowledge_point",
    "hint",
    "explanation",
    "active",
    "created_at",
    "updated_at"
  ],
  accepted_answers: [
    "id",
    "part_id",
    "position",
    "answer",
    "variant_type",
    "created_at"
  ],
  attempt_part_results: [
    "id",
    "attempt_id",
    "part_id",
    "raw_answer",
    "outcome",
    "feedback",
    "created_at"
  ],
  mistake_drafts: ["parts_json"],
  hint_events: ["part_id"]
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

const AGENT_MIGRATION_CHECKSUM_SOURCE = JSON.stringify({
  schema: AGENT_SCHEMA_SQL
});

const TOOLING_MIGRATION_CHECKSUM_SOURCE = JSON.stringify({
  schema: TOOLING_SCHEMA_SQL
});

const MISTAKE_EDITING_MIGRATION_CHECKSUM_SOURCE = JSON.stringify({
  schema: MISTAKE_EDITING_SCHEMA_SQL
});

const MULTI_PART_MIGRATION_CHECKSUM_SOURCE = JSON.stringify({
  schema: MULTI_PART_SCHEMA_SQL
});

export const SCHEMA_MIGRATIONS = [
  {
    version: 1,
    name: "baseline_learning_schema",
    checksumSource: BASELINE_MIGRATION_CHECKSUM_SOURCE,
    up(db) {
      db.exec(BASELINE_SCHEMA_SQL);
      seedBaselineData(db);

      for (const [table, columns] of Object.entries(
        BASELINE_REQUIRED_COLUMNS
      )) {
        assertRequiredColumns(db, table, columns);
      }
    }
  },
  {
    version: 2,
    name: "agent_learning_records",
    checksumSource: AGENT_MIGRATION_CHECKSUM_SOURCE,
    up(db) {
      db.exec(AGENT_SCHEMA_SQL);
      for (const [table, columns] of Object.entries(
        AGENT_SCHEMA_REQUIRED_COLUMNS
      )) {
        assertRequiredColumns(db, table, columns);
      }
    }
  },
  {
    version: 3,
    name: "tooling_contract",
    checksumSource: TOOLING_MIGRATION_CHECKSUM_SOURCE,
    up(db) {
      db.exec(TOOLING_SCHEMA_SQL);
      for (const [table, columns] of Object.entries(
        TOOLING_SCHEMA_REQUIRED_COLUMNS
      )) {
        assertRequiredColumns(db, table, columns);
      }
    }
  },
  {
    version: 4,
    name: "mistake_editing",
    checksumSource: MISTAKE_EDITING_MIGRATION_CHECKSUM_SOURCE,
    up(db) {
      db.exec(MISTAKE_EDITING_SCHEMA_SQL);
      for (const [table, columns] of Object.entries(
        MISTAKE_EDITING_SCHEMA_REQUIRED_COLUMNS
      )) {
        assertRequiredColumns(db, table, columns);
      }
    }
  },
  {
    version: 5,
    name: "multi_part_questions",
    checksumSource: MULTI_PART_MIGRATION_CHECKSUM_SOURCE,
    up(db) {
      db.exec(MULTI_PART_SCHEMA_SQL);
      for (const [table, columns] of Object.entries(
        MULTI_PART_SCHEMA_REQUIRED_COLUMNS
      )) {
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
