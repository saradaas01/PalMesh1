# Saved contacts, setup and mobile layout milestone

Imported/pinned public peer addresses now have an immutable read-only directory
API. New message offers saved-contact selection with the full fingerprint and
an explicit warning that saved keys are not a verified human identity. Discovery
alone does not pin a contact, failed directory writes are not offered as saved,
and imported addresses survive vault restart. No identity/database migration,
key replacement, contact deletion or automatic trust flag is introduced.

The English/Arabic identity screen includes expandable offline setup guidance:
private key exchange/fingerprint comparison, public-broadcast privacy, optional
radio permissions, local queue versus delivery, GPS/background opt-ins and SOS
limitations. It never opens a permission prompt itself. Navigation uses two
columns on narrow/large-font screens; message/send controls can wrap instead of
squeezing input. Full labels and font scaling remain enabled and SOS stays in
its existing prominent footer. Unit layout assertions are not physical-device
accessibility or keyboard acceptance.

Strict TypeScript, 374 core tests, 73 UI tests and module build passed on this
branch (based on consolidated work 7cf854e). Regressions verify imported address
persistence/immutability, discovery versus import, failed-save hiding/recovery,
actual import-to-recipient selection, setup without prompts, and narrow-screen
navigation with one emergency action. Native CI is tracked in the feature PR.
