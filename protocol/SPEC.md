# JeepTrack Wire Protocol v1

This is a contract: every implementation (`js/`, `python/`, `kotlin/`) must pass `test-vectors.json`.
Regenerate vectors only with `node js/gen-vectors.js`, and only when this spec changes.

## Position report — 28 bytes, big-endian

| Offset | Size | Field | Type | Unit / notes |
|--------|------|-------|------|--------------|
| 0 | 1 | version | u8 | `1` |
| 1 | 2 | jeep_id | u16 | registered device ID |
| 3 | 4 | seq | u32 | per-device, +1 per GPS fix, never resets (persist on phone) |
| 7 | 4 | ts | u32 | Unix seconds (UTC) at GPS fix |
| 11 | 4 | lat | i32 | degrees × 1e7 |
| 15 | 4 | lon | i32 | degrees × 1e7 |
| 19 | 2 | speed | u16 | cm/s |
| 21 | 2 | heading | u16 | degrees × 100 (0–35999) |
| 23 | 2 | accuracy | u16 | decimeters (cap 65535) |
| 25 | 1 | flags | u8 | bit0 = from offline buffer, bit1 = simulated |
| 26 | 2 | crc | u16 | CRC-16/CCITT-FALSE over bytes 0–25 |

CRC-16/CCITT-FALSE: poly `0x1021`, init `0xFFFF`, no reflection, xorout `0`. Check: `"123456789"` → `0x29B1`.

Field names in code and vectors: `version, jeep_id, seq, ts, lat_e7, lon_e7, speed_cms, heading_cdeg, accuracy_dm, flags` (Kotlin: camelCase).

## MQTT

- Topic: `jeeptrack/v1/jeep/{jeep_id}/pos`. Payload = one 28-byte report.
- Batch topic: `jeeptrack/v1/jeep/{jeep_id}/batch`. Payload = N concatenated reports, 1 ≤ N ≤ 200. One bad report rejects the batch.
- QoS 1. Client ID `jeep-{jeep_id}`. Clean start = false, session expiry = 3600 s.
- Auth: username `jeep-{jeep_id}`, password = device token. ACL: each device may only publish to its own topics.

## SMS fallback

- Text: `JT1:<base64url(report)>:<base64url(hmac8)>`. Unpadded, so always 4 + 38 + 1 + 11 = 54 chars.
- `hmac8` = first 8 bytes of HMAC-SHA256(device_sms_key, report bytes). Compare in constant time.
- The gateway/server also rejects `ts` older than 15 min or more than 2 min in the future (not a codec concern).

## Error codes

Decoders throw/raise `ProtocolError` with one of:

| code | meaning |
|------|---------|
| `length` | report ≠ 28 bytes, or batch length not a multiple of 28 / empty / > 200 reports |
| `version` | version byte ≠ 1 |
| `crc` | CRC mismatch |
| `range` | (encode only) a field is out of range or not an integer. `accuracy` is clamped to 65535, not rejected |
| `prefix` | SMS doesn't start with `JT1:` |
| `format` | SMS doesn't have 3 parts, or the parts have wrong base64url length/characters |
| `unknown_jeep` | no SMS key for the decoded `jeep_id` |
| `hmac` | HMAC mismatch |

SMS check order: prefix → format → report decode (length/version/crc) → unknown_jeep → hmac.
