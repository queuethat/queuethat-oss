# Kiosk setup

How to run `/kiosk` on a tablet or a small PC at the front desk, with or without a ticket printer.
The kiosk is the normal web app at `/kiosk`; there is no separate install. Nothing here was tested
on real printers yet (2A-KSK2 shipped with print emulation tests only), so treat the hardware
steps as the starting point for the first real pilot and correct this page afterwards.

## Pair the screen

1. In `/admin/devices`, create a pairing code for the location with kind **kiosk** (valid 10 minutes).
2. Open `https://<your-domain>/kiosk` on the device and type the code. The device keeps its session
   across reloads; an admin can revoke it from the same page.
3. The kiosk shows the welcome screen, or "We are not taking check-ins right now" when staff have
   paused or closed every queue.

The kiosk resets itself after 45 s of no input (a 20 s warning with "I need more time" comes first)
and 20 s after a check-in. It never stores a guest's name, phone or link on the device.

## Ticket printing

Open **Device settings** at the bottom of the kiosk and set **Print ticket**:

| Setting | What happens after a check-in |
| --- | --- |
| Off (default) | Nothing prints. |
| Ask the guest | The confirmation shows a "Print my ticket" button. |
| Always | The browser's print runs once, as soon as the confirmation shows. |

The setting lives in the device's `localStorage` (`qm:kiosk:print`), so it is per browser profile
and survives restarts. Clearing site data resets it to Off.

The slip is one column that fits a 58 mm roll and fills an 80 mm one: location name, big ticket,
queue, time joined (in the location's time zone) and a QR code to the guest's status page. The
browser prints it like any page, so no printer SDK or ESC/POS is involved.

### Chrome on Windows, Linux or ChromeOS (silent printing)

Start Chrome in kiosk mode with silent printing, so "Always" prints without a dialog:

```
chrome --kiosk --kiosk-printing https://<your-domain>/kiosk
```

- Install the thermal printer with its OS driver and make it the system **default printer**;
  `--kiosk-printing` sends to the default printer without asking.
- Set the driver's paper size to the roll width (58 mm or 80 mm, continuous length) and its
  margins to zero or the minimum. The slip also asks for no page margin (`@page slip`).
- If the printer cuts after every page, enable "cut after document" in the driver, not in the app.

### Android tablets

Chrome on Android always shows the print dialog, so use **Ask the guest**, or a kiosk browser that
supports silent printing. Pin the app with Android's screen pinning or a kiosk launcher so guests
cannot leave `/kiosk`.

### iPad

Safari and AirPrint always show the print sheet, and there is no silent mode. Use **Off** or
**Ask the guest**. Turn on Guided Access (Settings, Accessibility) with the touch area limited to
the page, and keep Auto-Lock off (the kiosk also asks for a screen wake lock).

## Checking it works

- Pair, set **Always**, check in once and look at the slip preview in the browser's print dialog
  (`Ctrl+P` shows the same layout on a desktop).
- If the slip prints on a full page with big margins, the driver ignores the roll size: set it in
  the driver, then retry.
