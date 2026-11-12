# データモデル

## reservations

| 列 | 型 | 説明 |
|---|---|---|
| id | uuid | 予約番号 |
| seat_id | text | 席の ID（`window-1` など） |
| period | tstzrange | 予約の時間帯。半開区間 `[開始, 終了)` |
| party_size | smallint | 人数（1〜4） |
| status | text | `confirmed` または `cancelled` |

## 重なりを禁止する

同じ席で、取り消されていない予約の時間帯が重なる行は、保存できないようにする。

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE reservations
  ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (seat_id WITH =, period WITH &&)
  WHERE (status = 'confirmed');
```

違反したときのエラーコードは `23P01`。アプリはこれを 409 に変える。
