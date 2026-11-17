"""Avoid unsupported ARM crypto instructions on the Kylin 5.4 baseline."""
import os
import sys

if sys.platform.startswith("linux"):
    os.environ.setdefault("OPENSSL_armcap", "0")
