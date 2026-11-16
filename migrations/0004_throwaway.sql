-- THROWAWAY (#10): a new clinic-scoped table with no policy. R1 must fail.
CREATE TABLE notes(
  id text PRIMARY KEY,
  body text NOT NULL,
  clinic_id text NOT NULL REFERENCES clinics(id)
);
