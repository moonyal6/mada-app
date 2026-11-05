-- The schema as it stood on SQLite (lib/server/db.ts at 0121936), with the
-- four later-added columns (sessions."therapistName", segments.preferred,
-- provider, note) folded in. #30, 8b-2.
--
-- camelCase names are quoted, or Postgres would fold them to lowercase and
-- `SELECT *` rows would reach the API with different keys. Types map
-- TEXT → text, INTEGER → integer, REAL → double precision. Flags stay 0/1
-- integers and timestamps stay ISO text.
--
-- One new column: inventory.seq, standing in for SQLite's rowid so the list
-- keeps insertion order. The API never returns it.

CREATE TABLE patients(
  id text PRIMARY KEY,
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  "fileNo" text NOT NULL DEFAULT '',
  age integer,
  sex text NOT NULL DEFAULT '',
  "caseKey" text NOT NULL,
  complaint text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'نشط',
  "createdAt" text NOT NULL
);

CREATE TABLE appointments(
  id text PRIMARY KEY,
  "patientId" text NOT NULL REFERENCES patients(id),
  date text NOT NULL,
  time text NOT NULL,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'محجوز'
);

CREATE TABLE invoices(
  id text PRIMARY KEY,
  "patientId" text NOT NULL REFERENCES patients(id),
  date text NOT NULL,
  items text NOT NULL DEFAULT '[]',
  total double precision NOT NULL DEFAULT 0,
  paid integer NOT NULL DEFAULT 0
);

CREATE TABLE inventory(
  id text PRIMARY KEY,
  name text NOT NULL,
  qty integer NOT NULL DEFAULT 0,
  min integer NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'قطعة',
  seq integer GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE sessions(
  id text PRIMARY KEY,
  "patientId" text NOT NULL REFERENCES patients(id),
  status text NOT NULL DEFAULT 'draft',
  "therapistName" text NOT NULL DEFAULT '',
  step integer NOT NULL DEFAULT 0,
  dialogue text NOT NULL DEFAULT '',
  assessment text NOT NULL DEFAULT '',
  dx text NOT NULL DEFAULT '',
  date text NOT NULL,
  "sessionsCount" text NOT NULL DEFAULT '',
  frequency text NOT NULL DEFAULT '',
  home text NOT NULL DEFAULT '',
  follow text NOT NULL DEFAULT '',
  pain text NOT NULL DEFAULT '',
  advice text NOT NULL DEFAULT '',
  "planNotes" text NOT NULL DEFAULT '',
  selected text NOT NULL DEFAULT '{}',
  "suggestedDx" text NOT NULL DEFAULT '[]',
  report text NOT NULL DEFAULT '',
  sealed integer NOT NULL DEFAULT 0,
  "sealDate" text NOT NULL DEFAULT '',
  "handoutToken" text NOT NULL UNIQUE,
  "consentAt" text,
  "createdAt" text NOT NULL,
  "updatedAt" text NOT NULL,
  "finishedAt" text
);

CREATE TABLE recordings(
  id text PRIMARY KEY,
  "sessionId" text NOT NULL REFERENCES sessions(id),
  mime text NOT NULL DEFAULT '',
  "startedAt" text NOT NULL
);

CREATE TABLE segments(
  "recordingId" text NOT NULL REFERENCES recordings(id),
  seq integer NOT NULL,
  status text NOT NULL DEFAULT 'uploaded',
  text text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  bytes integer NOT NULL DEFAULT 0,
  preferred text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  "createdAt" text NOT NULL,
  "updatedAt" text NOT NULL,
  PRIMARY KEY("recordingId", seq)
);

CREATE TABLE adherence(
  "sessionId" text NOT NULL REFERENCES sessions(id),
  day text NOT NULL,
  "exIdx" integer NOT NULL,
  done integer NOT NULL DEFAULT 1,
  "updatedAt" text NOT NULL,
  PRIMARY KEY("sessionId", day, "exIdx")
);

CREATE TABLE pain_logs(
  "sessionId" text NOT NULL REFERENCES sessions(id),
  day text NOT NULL,
  pain integer NOT NULL,
  "updatedAt" text NOT NULL,
  PRIMARY KEY("sessionId", day)
);

CREATE INDEX idx_appts_date ON appointments(date);
CREATE INDEX idx_sessions_patient ON sessions("patientId");
CREATE INDEX idx_segments_status ON segments(status);
