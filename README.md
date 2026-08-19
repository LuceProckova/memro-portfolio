# Memro

A flashcard web app for revising. Make sets of cards, study them, and it keeps
track of which ones you already know.

Built for the Java and Web Development portfolio (DLBCSPJWD01) at IU
Internationale Hochschule.

## What it does

- Sign up and log in, or study public sets without an account
- Make sets of cards, public or private
- Share a set with a 6 character code, other people get their own copy
- Study one card at a time, mark it known or not known
- A progress bar per set
- Dark mode and a few colour schemes
- Works on a phone and with the keyboard

## Running it

Needs Node
```
npm install
npm start
```

Then open http://localhost:3000

The database comes filled with a demo account already:

- username `lucia`
- password `flashcards`

## Testing

```
npm test
```

Runs 20 tests with the test runner built into Node.

## Built with

Node, Express, SQLite (`node:sqlite`), plain HTML/CSS/JS on the front end, and
Quill for the card editor.
