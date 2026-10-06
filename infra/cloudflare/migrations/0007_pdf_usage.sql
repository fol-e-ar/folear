-- Fol e ar · 0007: contador diario de PDFs por persoa (protexe a cota gratuíta de Browser Run).
-- Aditiva e idempotente. Se esta migración non está aplicada, o Worker simplemente non limita.

CREATE TABLE IF NOT EXISTS pdf_usage (
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
