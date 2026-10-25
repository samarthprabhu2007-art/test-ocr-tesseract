# RVCE card OCR test

Small client-side OCR experiment. Select or take a full student card photo and OCR begins immediately; there is no crop or submit step. It displays candidate name/USN fields, raw recognized text, and recognition time for the captured image.

## Run locally

```sh
npm install
npm run dev
```

Open the Vite localhost URL on the computer. For testing camera capture on a phone, deploy over HTTPS or use a secure local tunnel; camera access does not work on a plain HTTP LAN URL.

## Notes

- Tesseract.js and the English OCR engine run in the browser. Its worker and English language data are fetched on first load and cached by the browser; image pixels are not sent to an OCR service.
- The worker is initialized while the page loads, so image selection can start recognition without an extra action. The first page visit still includes engine download/initialization time.
- The complete photo is processed without cropping or OpenCV preprocessing. Recognition speed and field extraction quality need to be measured on real card photos and target phones.
- The ID parser accepts only the exact bounded pattern `RVCE` + two digits + `B` + two letters + three digits (for example, `RVCE25BCS104`). It does not correct lookalike OCR characters or replace mismatched characters.
- OCR output is only a suggestion and is not membership verification.
