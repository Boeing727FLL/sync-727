# מדריך העלאה ל-Netlify (Deploy Guide)

האפליקציה שלך מוכנה להעלאה ל-Netlify! הנה השלבים הפשוטים כדי להעלות אותה לאוויר:

## שלב 1: הכנת הקוד (GitHub)
1.  פתח חשבון ב-[GitHub](https://github.com/) (אם אין לך).
2.  צור **Repository** חדש (פרטי או ציבורי).
3.  העלה את כל קבצי הפרויקט ל-Repository הזה.

## שלב 2: חיבור ל-Netlify
1.  היכנס ל-[Netlify](https://www.netlify.com/).
2.  לחץ על **"Add new site"** -> **"Import from an existing project"**.
3.  בחר ב-**GitHub**.
4.  תן אישור ל-Netlify לגשת לחשבון ה-GitHub שלך.
5.  בחר את ה-Repository שיצרת בשלב 1.

## שלב 3: הגדרות (אוטומטיות)
Netlify יזהה אוטומטית את ההגדרות מקובץ `netlify.toml` שכבר הכנתי לך בפרויקט.
ודא שאתה רואה את ההגדרות הבאות:
*   **Build command:** `npm run build`
*   **Publish directory:** `dist`

## שלב 4: משתני סביבה (Environment Variables)
לפני שאתה לוחץ על "Deploy", לחץ על **"Show advanced"** -> **"New variable"** והוסף את המשתנים הבאים (אותם משתנים שיש לך בקובץ `.env`):

*   `VITE_SUPABASE_URL`: (הכתובת של Supabase שלך)
*   `VITE_SUPABASE_ANON_KEY`: (המפתח הסודי של Supabase)
*   `VITE_FIREBASE_API_KEY`: (אם יש לך)
*   `VITE_FIREBASE_AUTH_DOMAIN`: (אם יש לך)
*   `VITE_FIREBASE_PROJECT_ID`: (אם יש לך)
*   `GEMINI_API_KEY`: (המפתח של Gemini - אם אתה משתמש בו בצד שרת)

> **חשוב:** אל תעלה את קובץ `.env` ל-GitHub! המשתנים צריכים להיות מוגדרים רק ב-Netlify.

## שלב 5: Deploy
לחץ על **"Deploy site"**.
Netlify יתחיל לבנות את האפליקציה. זה ייקח דקה או שתיים.
בסיום, תקבל קישור (למשל `https://sync727.netlify.app`).

---

### שים לב: מגבלות ב-Netlify
מכיוון ש-Netlify הוא שירות "Serverless" (ללא שרת קבוע), יש כמה דברים שצריך לדעת:
1.  **WebSockets (צ'אט בזמן אמת):** לא יעבוד ב-Netlify. אם תרצה צ'אט חי מלא, תצטרך שרת כמו Render או Railway.
2.  **שמירת קבצים (Token):** שמירת הטוקן של Google Drive בקובץ מקומי (`drive-token.json`) לא תעבוד לאורך זמן כי השרת מתאפס כל הזמן. מומלץ לשמור את הטוקן בבסיס הנתונים (Supabase/Firebase) בעתיד.

בהצלחה! 🚀
