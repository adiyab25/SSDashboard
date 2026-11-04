-- Which languages the back office offers, in switcher order, and which one a first visit
-- opens in (spec 0004). ON CONFLICT keeps a value an install already changed.
INSERT INTO "settings" ("key", "value") VALUES
  ('languages', '["en", "ar"]'),
  ('default_language', '"en"')
ON CONFLICT ("key") DO NOTHING;
