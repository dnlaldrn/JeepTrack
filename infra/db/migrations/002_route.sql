CREATE TABLE route (
  id   INT PRIMARY KEY,
  geom GEOGRAPHY(LINESTRING, 4326) NOT NULL
);
CREATE TABLE stops (
  id       INT PRIMARY KEY,
  name     TEXT NOT NULL,
  order_no INT NOT NULL UNIQUE,
  geom     GEOGRAPHY(POINT, 4326) NOT NULL,
  route_m  REAL NOT NULL,      -- distance along the route (ST_LineLocatePoint × route length)
  verified BOOLEAN DEFAULT FALSE
);
