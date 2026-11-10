# Thermal ticket printing

Staff and kiosks print paper tickets through the browser's print dialog. No driver of ours is
involved (direct ESC/POS is a later phase).

## Settings

Admin > Location: **Ticket paper** (58 mm or 80 mm roll) and an optional **Ticket footer** (up to
120 characters). Stored on the location (`print_paper_mm`, `print_footer`); staff screens and
paired kiosks read them. The slip uses a named `@page` of that width with no margins.

## What prints

Ticket number (large), queue, join time in the location's time zone, the footer, and a QR to the
guest's status page `/v/<token>`. Kiosk tickets carry the QR. Tickets staff add by hand do not:
the link token exists only on the guest's device (invariant I-7), so there is nothing to encode.
Give those guests the number only, or let them join on their phone.

## Where

- **Staff:** after "Add guest", tap **Print ticket** in the confirmation toast.
- **Kiosk:** the device setting *Print ticket* (off, ask the guest, always).

## Silent printing

Set the printer as the OS default and start Chrome with `--kiosk-printing`
(for example `chrome --kiosk --kiosk-printing https://your-site/kiosk`). The dialog is skipped
and the slip prints at once. Without the flag the browser's dialog opens; pick the roll size
there if the driver ignores the page size.
