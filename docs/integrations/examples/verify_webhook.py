"""Verifies an X-QM-Signature header. Python 3.8+, standard library only.

    verify_webhook(secret, raw_body, header) -> bool

Use the RAW request body (the exact bytes received), not a re-serialised object.
"""
import hashlib
import hmac
import sys
import time


def verify_webhook(secret, raw_body, header, tolerance_seconds=300, now=None):
    now = time.time() if now is None else now
    parts = [p.strip().split("=", 1) for p in header.split(",") if "=" in p]
    try:
        t = int(next(v for k, v in parts if k == "t"))
    except (StopIteration, ValueError):
        return False
    if abs(now - t) > tolerance_seconds:
        return False
    expected = hmac.new(secret.encode(), f"{t}.{raw_body}".encode(), hashlib.sha256).hexdigest()
    # During a secret rotation the header carries one v1= value per secret; any match is valid.
    return any(k == "v1" and hmac.compare_digest(v, expected) for k, v in parts)


if __name__ == "__main__":
    # python verify_webhook.py <secret> <raw_body> <header> <now>  ->  prints true or false
    secret, body, header, now = sys.argv[1:5]
    print("true" if verify_webhook(secret, body, header, now=float(now)) else "false")
