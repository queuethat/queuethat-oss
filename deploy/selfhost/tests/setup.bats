#!/usr/bin/env bats
# setup.sh and check-secrets.sh (2P-OPS2, #208). Run: pnpm test:selfhost

setup() {
  DIR=$(cd "$BATS_TEST_DIRNAME/.." && pwd)
  WORK=$(mktemp -d)
}
teardown() { rm -rf "$WORK"; }

b64url_decode() { printf '%s' "$1" | tr '_-' '/+' | { cat; echo '=='; } | openssl base64 -d -A 2>/dev/null; }
value() { sed -n "s/^$1=//p" "$2"; }

@test "AC1: a second run refuses and leaves .env unchanged" {
  run "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env"
  [ "$status" -eq 0 ]
  before=$(cksum <"$WORK/.env")
  run "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env"
  [ "$status" -ne 0 ]
  [[ "$output" == *"--rotate"* ]]
  [ "$before" = "$(cksum <"$WORK/.env")" ]
}

@test ".env is written with mode 600 and a rotate keeps the old one as a mode 600 backup" {
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env"
  [ "$(stat -c %a "$WORK/.env")" = 600 ]
  old=$(value JWT_SECRET "$WORK/.env")
  run "$DIR/setup.sh" --non-interactive --rotate --env-file "$WORK/.env"
  [ "$status" -eq 0 ]
  [[ "$output" == *"What breaks"* ]]
  [ "$old" != "$(value JWT_SECRET "$WORK/.env")" ]
  backup=$(ls "$WORK"/.env.bak-*)
  [ "$(stat -c %a "$backup")" = 600 ]
  [ "$old" = "$(value JWT_SECRET "$backup")" ]
}

@test "rotate keeps the database password, which Postgres reads only once" {
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env"
  old=$(value POSTGRES_PASSWORD "$WORK/.env")
  "$DIR/setup.sh" --non-interactive --rotate --env-file "$WORK/.env"
  [ "$old" = "$(value POSTGRES_PASSWORD "$WORK/.env")" ]
}

@test "AC2: two runs in different directories share no secret value" {
  mkdir "$WORK/a" "$WORK/b"
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/a/.env"
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/b/.env"
  for name in POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY SECRET_KEY_BASE VAULT_ENC_KEY \
    PG_META_CRYPTO_KEY DASHBOARD_PASSWORD DISPATCH_SECRET VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY; do
    a=$(value "$name" "$WORK/a/.env")
    [ -n "$a" ]
    [ "$a" != "$(value "$name" "$WORK/b/.env")" ]
  done
}

@test "every secret is long enough and the file passes check-secrets" {
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env"
  [ "$(value JWT_SECRET "$WORK/.env" | tr -d '\n' | wc -c)" -ge 40 ]
  run env -i PATH="$PATH" sh -c "set -a; . '$WORK/.env'; set +a; sh '$DIR/check-secrets.sh'"
  [ "$status" -eq 0 ]
}

@test "AC4: ANON_KEY decodes to role anon and verifies against JWT_SECRET" {
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env"
  token=$(value ANON_KEY "$WORK/.env")
  secret=$(value JWT_SECRET "$WORK/.env")
  IFS=. read -r h p s <<<"$token"
  [[ "$(b64url_decode "$p")" == *'"role":"anon"'* ]]
  want=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$secret" -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  [ "$want" = "$s" ]
  [[ "$(b64url_decode "$(value SERVICE_ROLE_KEY "$WORK/.env" | cut -d. -f2)")" == *'"role":"service_role"'* ]]
}

@test "the VAPID public key is the 65-byte point of a P-256 key" {
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env"
  [ "$(value VAPID_PUBLIC_KEY "$WORK/.env" | tr -d '\n' | wc -c)" -eq 87 ]
  [ "$(value VAPID_PRIVATE_KEY "$WORK/.env" | tr -d '\n' | wc -c)" -eq 43 ]
}

@test "flags set the URL, sign-up mode and SMTP" {
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env" --public-url https://q.example.com/ \
    --signup open --smtp-host smtp.example.com --smtp-from ops@example.com
  [ "$(value PUBLIC_URL "$WORK/.env")" = https://q.example.com ]
  [ "$(value DISABLE_SIGNUP "$WORK/.env")" = false ]
  [ "$(value SMTP_HOST "$WORK/.env")" = smtp.example.com ]
  [ "$(value VAPID_SUBJECT "$WORK/.env")" = mailto:ops@example.com ]
}

@test "a bad flag or URL fails without writing .env" {
  run "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env" --public-url queue.example.com
  [ "$status" -ne 0 ]
  run "$DIR/setup.sh" --nope
  [ "$status" -ne 0 ]
  [ ! -e "$WORK/.env" ]
}

# The published Supabase demo values (checked by hash and by claim).
DEMO_ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlLWRlbW8iLCJpYXQiOjE2NDE3NjkyMDAsImV4cCI6MTc5OTUzNTYwMH0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE'
DEMO_SECRET='super-secret-jwt-token-with-at-least-32-characters-long'

@test "AC3: the demo anon key fails, naming the variable and not its value" {
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env"
  run env -i PATH="$PATH" sh -c "set -a; . '$WORK/.env'; ANON_KEY='$DEMO_ANON'; set +a; sh '$DIR/check-secrets.sh'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"ANON_KEY"* ]]
  [[ "$output" != *"$DEMO_ANON"* ]]
}

@test "the demo JWT secret fails" {
  run env -i PATH="$PATH" JWT_SECRET="$DEMO_SECRET" sh "$DIR/check-secrets.sh" JWT_SECRET
  [ "$status" -ne 0 ]
  [[ "$output" == *"JWT_SECRET"* ]]
  [[ "$output" != *"$DEMO_SECRET"* ]]
}

@test "any key with iss supabase-demo fails even when it is not on the hash list" {
  other=$(printf '{"role":"anon","iss":"supabase-demo","iat":1}' | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  run env -i PATH="$PATH" ANON_KEY="x.$other.y" sh "$DIR/check-secrets.sh" ANON_KEY
  [ "$status" -ne 0 ]
  [[ "$output" == *"supabase-demo"* ]]
}

@test "empty, short and wrong-role secrets fail" {
  run env -i PATH="$PATH" sh "$DIR/check-secrets.sh" JWT_SECRET
  [ "$status" -ne 0 ]
  run env -i PATH="$PATH" POSTGRES_PASSWORD=short sh "$DIR/check-secrets.sh" POSTGRES_PASSWORD
  [ "$status" -ne 0 ]
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env"
  run env -i PATH="$PATH" ANON_KEY="$(value SERVICE_ROLE_KEY "$WORK/.env")" sh "$DIR/check-secrets.sh" ANON_KEY
  [ "$status" -ne 0 ]
  [[ "$output" == *"role anon"* ]]
}

@test "a key signed with another secret fails when JWT_SECRET is known" {
  mkdir "$WORK/a" "$WORK/b"
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/a/.env"
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/b/.env"
  run env -i PATH="$PATH" JWT_SECRET="$(value JWT_SECRET "$WORK/a/.env")" ANON_KEY="$(value ANON_KEY "$WORK/b/.env")" \
    sh "$DIR/check-secrets.sh" ANON_KEY
  [ "$status" -ne 0 ]
  [[ "$output" == *"not signed with JWT_SECRET"* ]]
}

@test "a value that could break .env or run as shell is refused before anything is written" {
  for bad in 'a b' 'a;b' 'a$b' 'a"b' "a'b" 'a#b' 'a`b`'; do
    run "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env" --smtp-host h --smtp-pass "$bad"
    [ "$status" -ne 0 ]
    [ ! -e "$WORK/.env" ]
  done
  run "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env" --smtp-host h --smtp-pass $'a\nJWT_SECRET=x'
  [ "$status" -ne 0 ]
  [ ! -e "$WORK/.env" ]
}

@test "rotate keeps the public URL, sign-up mode and SMTP settings" {
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env" --public-url https://q.example.com --signup open \
    --smtp-host smtp.example.com --smtp-user u --smtp-pass p --smtp-from ops@example.com
  "$DIR/setup.sh" --non-interactive --rotate --env-file "$WORK/.env"
  [ "$(value PUBLIC_URL "$WORK/.env")" = https://q.example.com ]
  [ "$(value DISABLE_SIGNUP "$WORK/.env")" = false ]
  [ "$(value SMTP_HOST "$WORK/.env")" = smtp.example.com ]
  [ "$(value SMTP_PASS "$WORK/.env")" = p ]
  [ "$(value SMTP_ADMIN_EMAIL "$WORK/.env")" = ops@example.com ]
}

@test "the public Realtime key and whitespace-padded demo values are refused" {
  run env -i PATH="$PATH" REALTIME_DB_ENC_KEY=supabaserealtime sh "$DIR/check-secrets.sh" REALTIME_DB_ENC_KEY
  [ "$status" -ne 0 ]
  run env -i PATH="$PATH" JWT_SECRET="  $DEMO_SECRET " sh "$DIR/check-secrets.sh" JWT_SECRET
  [ "$status" -ne 0 ]
}

@test "212: a clean setup has DEMO_MODE=false and no demo password" {
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env"
  [ "$(value DEMO_MODE "$WORK/.env")" = false ]
  [ -z "$(value DEMO_PASSWORD "$WORK/.env")" ]
}

@test "212: --demo generates a demo password, never password123, and a rotate keeps it" {
  run "$DIR/setup.sh" --non-interactive --demo --env-file "$WORK/.env"
  [ "$status" -eq 0 ]
  [[ "$output" == *"owner@demo.test"* ]]
  [ "$(value DEMO_MODE "$WORK/.env")" = true ]
  pw=$(value DEMO_PASSWORD "$WORK/.env")
  [ "${#pw}" -ge 12 ]
  [ "$pw" != password123 ]
  [[ "$output" != *"$pw"* ]]
  "$DIR/setup.sh" --non-interactive --rotate --env-file "$WORK/.env"
  [ "$(value DEMO_MODE "$WORK/.env")" = true ]
  [ "$pw" = "$(value DEMO_PASSWORD "$WORK/.env")" ]
}
