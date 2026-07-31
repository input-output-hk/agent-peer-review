# Cryptography Review

Ground checks in the OWASP Cryptographic Storage and Password Storage Cheat Sheets. Check the diff for:

- **Vetted primitives only:** no homegrown ciphers, hashes, encodings-as-encryption, or hand-rolled protocols; require a maintained library (a language-standard crypto module, libsodium, BoringSSL/OpenSSL) for every cryptographic operation.
- **AEAD by default:** prefer authenticated encryption, AES-GCM, ChaCha20-Poly1305, or AES-CCM, over unauthenticated modes; if CBC or CTR appears, confirm a separate MAC is applied and verified before decryption (Encrypt-then-MAC), and reject ECB outright.
- **Unique nonces and IVs:** every encryption call needs a fresh, unpredictable IV/nonce; flag hardcoded, zeroed, counter-reset-on-restart, or otherwise reused nonces, especially with GCM or a stream cipher, where reuse breaks both confidentiality and integrity.
- **Correct modes and padding:** flag padding-oracle-prone combinations (CBC with PKCS#7 and no prior MAC check), authentication tags that are truncated or not verified before the plaintext is used, and custom padding schemes.
- **Secure randomness:** keys, salts, IVs, tokens, and session identifiers must come from a CSPRNG (`crypto/rand`, `SecureRandom`, `os.urandom`, `crypto.getRandomValues`); flag `Math.random()`, `rand()`, seeded PRNGs, or timestamp/UUIDv1-derived values used for anything security-sensitive.
- **Password hashing and KDFs:** passwords must go through Argon2id (preferred; memory 19 MiB or higher, iterations 2 or more, parallelism 1), scrypt (N = 2^17 or higher, r = 8, p = 1), bcrypt (cost 10 or higher, 72-byte input cap), or PBKDF2-HMAC-SHA256 (600,000 iterations or more) only where FIPS compliance forces it. A bare fast hash (MD5, SHA-256), even salted, is not acceptable.
- **Constant-time comparison:** secrets, MACs, tokens, and password hashes must be compared with a constant-time function (`hmac.compare_digest`, `crypto.timingSafeEqual`, `subtle.ConstantTimeCompare`), never `==` or `memcmp`, which leak timing information an attacker can exploit.
- **Key management:** keys live separately from the data they protect, in an HSM, cloud KMS, or secrets manager, never hardcoded, committed, or logged; check that rotation is possible without downtime and that old ciphertext has a re-encryption or dual-read migration path.
- **Deprecated algorithms:** flag any new use of MD5, SHA-1, DES/3DES, RC4, ECB mode, or raw RSA without OAEP padding; treat existing use inside touched code as a finding too, not just new use.
- **TLS configuration:** require TLS 1.2 or higher (prefer 1.3), AEAD cipher suites with forward secrecy (ECDHE), and intact certificate/hostname validation; flag any diff that disables verification (`verify=False`, `InsecureSkipVerify`, `rejectUnauthorized: false`) or pins a weak cipher list.

Treat cryptographic deviations as findings by default; there is rarely a "minor" crypto bug.
