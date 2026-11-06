CREATE TABLE jeepneys (
  id         INT PRIMARY KEY,
  plate      TEXT NOT NULL,
  token_hash TEXT NOT NULL,      -- bcrypt of MQTT password
  sms_key    BYTEA NOT NULL,     -- HMAC key for SMS
  active     BOOLEAN DEFAULT TRUE
);
CREATE TABLE positions (
  jeep_id    INT REFERENCES jeepneys(id),
  seq        BIGINT NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  geom       GEOGRAPHY(POINT, 4326) NOT NULL,
  speed_mps  REAL, heading_deg REAL, accuracy_m REAL,
  source     TEXT CHECK (source IN ('mqtt','batch','sms')),
  received_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (jeep_id, seq)     -- de-duplication (R3)
);
CREATE INDEX ON positions (jeep_id, ts DESC);
