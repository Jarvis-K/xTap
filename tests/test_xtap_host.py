"""Tests for native-host/xtap_host.py message framing robustness."""

import io
import json
import struct
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'native-host'))
import xtap_host  # noqa: E402


class ChunkedReader:
    """Byte reader that returns data in fixed-size chunks to simulate pipe fragmentation."""

    def __init__(self, data, chunk_size):
        self._buf = io.BytesIO(data)
        self._chunk_size = chunk_size

    def read(self, size=-1):
        if size < 0:
            return self._buf.read(size)
        return self._buf.read(min(size, self._chunk_size))


class FakeStdin:
    def __init__(self, reader):
        self.buffer = reader


def _pack_msg(obj):
    payload = json.dumps(obj).encode('utf-8')
    return struct.pack('<I', len(payload)) + payload


def test_read_message_handles_chunked_pipe(monkeypatch):
    raw = _pack_msg({'type': 'GET_TOKEN'})
    reader = ChunkedReader(raw, chunk_size=3)
    monkeypatch.setattr(xtap_host.sys, 'stdin', FakeStdin(reader))

    msg = xtap_host.read_message()
    assert msg == {'type': 'GET_TOKEN'}


def test_read_message_invalid_json_raises_value_error(monkeypatch):
    payload = b'{"type":'
    raw = struct.pack('<I', len(payload)) + payload
    monkeypatch.setattr(xtap_host.sys, 'stdin', FakeStdin(io.BytesIO(raw)))

    with pytest.raises(ValueError, match='Invalid JSON payload'):
        xtap_host.read_message()


def test_read_message_eof_mid_payload_raises_eoferror(monkeypatch):
    raw = struct.pack('<I', 10) + b'abc'
    monkeypatch.setattr(xtap_host.sys, 'stdin', FakeStdin(io.BytesIO(raw)))

    with pytest.raises(EOFError, match='Unexpected EOF'):
        xtap_host.read_message()
