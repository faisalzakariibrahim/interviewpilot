"""Field encryption for cloud mode.

Content (resume passages, role, job description, notes, interview transcripts
and scores) is sealed with AES-256-GCM before it is sent to Supabase. The key
lives only in the backend's environment (DATA_ENCRYPTION_KEY), never in the
database. Someone who reads the database without the key — through the
dashboard, a backup, or a policy mistake — sees ciphertext.

Each value is bound to its table, owner and row id (the "associated data"), so
a sealed value copied into another row or another user's row won't open.
"""

import base64
import os
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PREFIX = "v1:"


class CryptoError(Exception):
    pass


def generate_key() -> str:
    return base64.urlsafe_b64encode(os.urandom(32)).decode("ascii")


class Sealer:
    def __init__(self, key_b64: Optional[str]) -> None:
        if not key_b64:
            raise CryptoError("DATA_ENCRYPTION_KEY is not set.")
        try:
            key = base64.urlsafe_b64decode(key_b64.strip() + "=" * (-len(key_b64.strip()) % 4))
        except ValueError as error:
            raise CryptoError("DATA_ENCRYPTION_KEY is not valid base64.") from error
        if len(key) != 32:
            raise CryptoError("DATA_ENCRYPTION_KEY must be 32 bytes (base64).")
        self._aead = AESGCM(key)

    def seal(self, plaintext: str, context: str) -> str:
        nonce = os.urandom(12)
        sealed = self._aead.encrypt(nonce, plaintext.encode("utf-8"), context.encode("utf-8"))
        return PREFIX + base64.b64encode(nonce + sealed).decode("ascii")

    def open(self, token: str, context: str) -> str:
        if not isinstance(token, str) or not token.startswith(PREFIX):
            raise CryptoError("Not a sealed value.")
        raw = base64.b64decode(token[len(PREFIX):])
        try:
            return self._aead.decrypt(raw[:12], raw[12:], context.encode("utf-8")).decode("utf-8")
        except Exception as error:  # InvalidTag: wrong key, wrong row, or tampered
            raise CryptoError("A stored value could not be decrypted.") from error
