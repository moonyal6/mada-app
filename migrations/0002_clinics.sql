-- Every row belongs to a clinic (#9, 9a).
--
-- One clinic, c1, owns every existing row. clinic_id is added with a
-- temporary DEFAULT 'c1' only to backfill those rows in the same statement;
-- the default is then dropped, so an insert that forgets the clinic fails
-- (23502) instead of quietly landing in c1.
--
-- A child row can't belong to a different clinic than its parent: each
-- parent gets UNIQUE(id, clinic_id), and each child a composite FK on
-- (parent id, clinic_id). The single-column FKs from 0001 stay.
--
-- The column is snake_case, as #9 and #10 name it; the camelCase columns
-- from 0001 keep their quotes.

CREATE TABLE clinics(
  id text PRIMARY KEY,
  name text NOT NULL,
  "createdAt" text NOT NULL
);

INSERT INTO clinics(id, name, "createdAt")
VALUES (
  'c1',
  'عيادة العلاج الطبيعي',
  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- Backfill to c1, then drop the default.
ALTER TABLE patients     ADD COLUMN clinic_id text NOT NULL DEFAULT 'c1' REFERENCES clinics(id);
ALTER TABLE appointments ADD COLUMN clinic_id text NOT NULL DEFAULT 'c1' REFERENCES clinics(id);
ALTER TABLE invoices     ADD COLUMN clinic_id text NOT NULL DEFAULT 'c1' REFERENCES clinics(id);
ALTER TABLE inventory    ADD COLUMN clinic_id text NOT NULL DEFAULT 'c1' REFERENCES clinics(id);
ALTER TABLE sessions     ADD COLUMN clinic_id text NOT NULL DEFAULT 'c1' REFERENCES clinics(id);
ALTER TABLE recordings   ADD COLUMN clinic_id text NOT NULL DEFAULT 'c1' REFERENCES clinics(id);
ALTER TABLE segments     ADD COLUMN clinic_id text NOT NULL DEFAULT 'c1' REFERENCES clinics(id);
ALTER TABLE adherence    ADD COLUMN clinic_id text NOT NULL DEFAULT 'c1' REFERENCES clinics(id);
ALTER TABLE pain_logs    ADD COLUMN clinic_id text NOT NULL DEFAULT 'c1' REFERENCES clinics(id);

ALTER TABLE patients     ALTER COLUMN clinic_id DROP DEFAULT;
ALTER TABLE appointments ALTER COLUMN clinic_id DROP DEFAULT;
ALTER TABLE invoices     ALTER COLUMN clinic_id DROP DEFAULT;
ALTER TABLE sessions     ALTER COLUMN clinic_id DROP DEFAULT;
ALTER TABLE recordings   ALTER COLUMN clinic_id DROP DEFAULT;
ALTER TABLE segments     ALTER COLUMN clinic_id DROP DEFAULT;
ALTER TABLE adherence    ALTER COLUMN clinic_id DROP DEFAULT;
ALTER TABLE pain_logs    ALTER COLUMN clinic_id DROP DEFAULT;

-- The targets of the composite FKs below.
ALTER TABLE patients   ADD UNIQUE (id, clinic_id);
ALTER TABLE sessions   ADD UNIQUE (id, clinic_id);
ALTER TABLE recordings ADD UNIQUE (id, clinic_id);

-- A child's clinic is its parent's clinic.
ALTER TABLE appointments ADD FOREIGN KEY ("patientId", clinic_id)   REFERENCES patients(id, clinic_id);
ALTER TABLE invoices     ADD FOREIGN KEY ("patientId", clinic_id)   REFERENCES patients(id, clinic_id);
ALTER TABLE sessions     ADD FOREIGN KEY ("patientId", clinic_id)   REFERENCES patients(id, clinic_id);
ALTER TABLE recordings   ADD FOREIGN KEY ("sessionId", clinic_id)   REFERENCES sessions(id, clinic_id);
ALTER TABLE segments     ADD FOREIGN KEY ("recordingId", clinic_id) REFERENCES recordings(id, clinic_id);
ALTER TABLE adherence    ADD FOREIGN KEY ("sessionId", clinic_id)   REFERENCES sessions(id, clinic_id);
ALTER TABLE pain_logs    ADD FOREIGN KEY ("sessionId", clinic_id)   REFERENCES sessions(id, clinic_id);
