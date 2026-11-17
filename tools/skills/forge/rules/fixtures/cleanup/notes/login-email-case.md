# Login email is case-sensitive

src/auth.js sends the email as typed; the server compares it exactly, so "Ann@x.com" and "ann@x.com" are two users. Lower-case it before calling login().
