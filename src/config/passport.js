const passport = require("passport");
const GoogleStrategy =
  require("passport-google-oauth20").Strategy;

const pool = require("./db");

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret:
        process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:
        process.env.GOOGLE_CALLBACK_URL,
    },
    async (
      accessToken,
      refreshToken,
      profile,
      done
    ) => {
      try {
        const googleId = profile.id;
        const email =
          profile.emails[0].value;
        if (!email.endsWith('@shnoor.com')) {
          return done(null, false, { message: 'Only @shnoor.com accounts are allowed' });
        }
        const name =
          profile.displayName;
        const avatar =
          profile.photos[0].value;

        let user = await pool.query(
          "SELECT * FROM users WHERE google_id=$1",
          [googleId]
        );

        if (user.rows.length === 0) {
          user = await pool.query(
            `
            INSERT INTO users
            (google_id, email, name, avatar_url)
            VALUES ($1,$2,$3,$4)
            RETURNING *
            `,
            [googleId, email, name, avatar]
          );
        }

        return done(null, user.rows[0]);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(
  async (id, done) => {
    try {
      const user = await pool.query(
        "SELECT * FROM users WHERE id=$1",
        [id]
      );

      done(null, user.rows[0]);
    } catch (err) {
      done(err, null);
    }
  }
);

module.exports = passport;