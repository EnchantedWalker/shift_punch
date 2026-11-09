# Setting up Shift Punch

Shift Punch keeps everyone's hours in Firebase, Google's free app database. You need to do this once, and it takes about 10 minutes. Everything here fits in Firebase's free plan (Spark). You never need to enter a credit card.

## 1. Create a Firebase project
1. Go to https://console.firebase.google.com and sign in with a Google account.
2. Tap **Create a project**. Name it `shift-punch`.
3. Google Analytics isn't needed. Turn it off, then tap **Create project**.

## 2. Turn on email sign-in
1. In the left menu, open **Build → Authentication**, then tap **Get started**.
2. Under **Sign-in method**, choose **Email/Password**, switch on the first toggle (**Email/Password**) and **Save**. Leave "Email link" off.

## 3. Create the database
1. In the left menu, open **Build → Firestore Database**, then tap **Create database**.
2. Pick the location closest to you (for example `nam5 (United States)`). You can't change it later.
3. Choose **Start in production mode**, then **Create**.
4. Open the **Rules** tab. Delete everything there, paste in the full contents of `firestore.rules` from this repository, and tap **Publish**.

## 4. Connect the app
1. Tap the gear icon next to **Project Overview** → **Project settings**.
2. Under **Your apps**, tap the web icon `</>`. Name it `Shift Punch`, leave "Firebase Hosting" unchecked, and tap **Register app**.
3. Firebase shows a block of code containing `const firebaseConfig = { ... }`. Copy just the part from `{` to `}`.
4. Send that to Claude, or paste it into `firebase-config.js` in place of `null`.

These settings aren't secret. Every Firebase web app publishes them. The rules from step 3 are what keep each person's hours private.

## 5. Put it online with GitHub Pages
1. On GitHub, open this repository → **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*, choose `main` and `/ (root)`, and **Save**.
3. After a minute or two, the app is live at https://enchantedwalker.github.io/shift_punch/

The repository must be public for free GitHub Pages.

## If you change the rules later
Paste the new `firestore.rules` into **Firestore Database → Rules** and tap **Publish**. The app doesn't pick up rule changes from GitHub by itself.

## Running the tests (for developers)
```
npm install
npm run test:rules            # who can read and write what
python3 -m http.server 5055 & # then:
npm run test:e2e              # signs up a leader and a member and walks through groups
```
Both use Firebase's local emulators and need Java 11 or newer.
