# LFF Accommodation – Third-party API (v1)

Base URL: `https://<your-backend>.vercel.app/api/v1`
Auth: header `x-api-key: lff_...` (create keys in **Admin → API keys**). Keep keys server-side.
All responses: `{ "success": true, "data": ..., "meta"?: {page,limit,total} }` or `{ "success": false, "message", "code" }`.
Money is in Naira (₦). Dates are ISO-8601.

Everything the visitor website can do is available, plus lookups, cancellations and webhooks.

## Catalogue

| Method | Path | Notes |
|---|---|---|
| GET | `/accommodations` | Query: `startDate`, `durationDays` (adds a `quote` per item), `availableOnly=true`, `type`, `minCapacity`, `page`, `limit`. Locked accommodations never appear. |
| GET | `/accommodations/:id` | Includes `blockedRanges` (`reason`: `full` or `event`) for calendars. |
| GET | `/accommodations/:id/quote?startDate=&durationDays=` | Price breakdown per day (event pricing applied) + availability. |
| GET | `/events` , `/events/:id` | Upcoming events and the accommodations open for them with event prices. |
| GET | `/settings` | Church name/contact, active bank accounts, `paystackPublicKey`. |

**Full accommodations.** Each accommodation has `totalUnits` (e.g. 6 beds). Listing/detail items include `totalUnits`, `unitsLeft` and `isFull` (right now). A quote includes `isFull`, `unitsLeft`, `totalUnits` and `available` for the requested dates. A full accommodation returns `409 NOT_AVAILABLE` when booked.

## Booking

`POST /bookings`
```json
{
  "accommodationId": "…", "startDate": "2026-11-20T12:00:00.000Z", "durationDays": 3,
  "paymentMethod": "paystack",            // or "bank_transfer"
  "callbackUrl": "https://yourapp.com/paid", // optional, Paystack redirects here with ?reference=
  "visitor": { "name": "", "email": "", "phone": "", "whatsapp": "" }
}
```
Returns `booking` (with `code`, the **accommodation ID**), `profileToken`, `profileUrl` (visitor's personal page, valid until 12h after the stay ends), `payment.reference`, and either `authorizationUrl` (Paystack) or `bankAccounts` (transfer).

| Method | Path | Notes |
|---|---|---|
| POST | `/payments/verify` `{reference}` | Call after Paystack redirects back. Idempotent. |
| POST | `/payments/:reference/transfer-proof` | Bank transfer: `{senderName, senderBank?, transferReference?, proofUrl?, note?}`. Admin is notified to confirm. |
| GET | `/payments/:reference` | Payment status. |
| GET | `/bookings/:code` | Full booking + payments + `profileUrl`. |
| GET | `/bookings?email=&phone=&status=` | Search bookings. |
| GET | `/bookings/profile/:token` | Same as the visitor profile page data. |
| POST | `/bookings/:code/extend` `{extraDays, paymentMethod}` | Returns a payment (and `authorizationUrl`) for the extension; applied automatically once paid. |
| POST | `/bookings/:code/cancel` | Only while unpaid / awaiting confirmation. |

Booking `status`: `pending_payment` → `awaiting_confirmation` (transfer submitted) → `active` → `completed` (signed out). Also `cancelled`, `expired` (unpaid hold lapsed).
Unpaid bookings hold the slot for `PAYSTACK_HOLD_MINUTES` / `BANK_TRANSFER_HOLD_MINUTES`.

## Webhooks (optional)

`PUT /webhook` `{ "url": "https://yourapp.com/hooks/lff", "secret": "min-8-chars" }`
We POST `{event, data, sentAt}` with headers `x-lff-event` and `x-lff-signature` = hex HMAC-SHA256 of the raw body using your secret.

Events: `booking.confirmed`, `booking.extended`, `booking.expiring` (5h before end), `booking.expired`, `booking.checked_out`, `booking.cancelled`, `accommodation.full`.

## Errors
`400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `404 NOT_FOUND`, `409 NOT_AVAILABLE | CONFLICT`, `410 LINK_EXPIRED`, `429` rate limited (300 req/min per IP), `5xx`.
