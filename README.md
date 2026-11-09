# Shift Punch

A phone-friendly time clock. Clock in and out, log meal breaks, and see a timesheet with daily hours, breaks and gross pay.

**Groups:** anyone can start a group and add people by email. Once someone accepts, the group leader sees each member's punches, hours worked, meal breaks, days worked and gross pay. Leaders can view punches but not change them. Members fix their own.

**Handing off a group:** a leader can offer the group to anyone who has joined it. Once that person accepts, they become the leader and the old leader loses access, unless the old leader chose to stay on as a regular member.

## Files
- `index.html`, `styles.css`, `app.js`: the app
- `firebase-config.js`: your Firebase project's settings (see `SETUP.md`)
- `firestore.rules`: who can see and change what. Paste it into the Firebase console whenever it changes.
- `manifest.webmanifest`, `sw.js`, `icons/`: what makes it installable on a phone and able to open with no signal
- `tests/`: security-rule tests and a two-person walkthrough, both run on Firebase's local emulators

To get it running, follow `SETUP.md`.
