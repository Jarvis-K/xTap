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


class FakeStdout:
    def __init__(self):
        self.buffer = io.BytesIO()


def _pack_msg(obj):
    payload = json.dumps(obj).encode('utf-8')
    return struct.pack('<I', len(payload)) + payload


def _read_framed(buf):
    raw = buf.read(4)
    if not raw:
        return None
    size = struct.unpack('<I', raw)[0]
    return json.loads(buf.read(size))


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


def test_get_token_does_not_require_storage_init(monkeypatch, tmp_path):
    secret = tmp_path / 'secret'
    secret.write_text('tok123', encoding='utf-8')
    monkeypatch.setattr(xtap_host, 'XTAP_SECRET', str(secret))
    monkeypatch.setattr(xtap_host, 'DEFAULT_OUTPUT_DIR', '/forbidden-output-dir')

    call_count = {'makedirs': 0}

    def fail_makedirs(*_args, **_kwargs):
        call_count['makedirs'] += 1
        raise PermissionError('no access')

    raw_in = _pack_msg({'type': 'GET_TOKEN'})
    fake_in = FakeStdin(io.BytesIO(raw_in))
    fake_out = FakeStdout()
    monkeypatch.setattr(xtap_host.sys, 'stdin', fake_in)
    monkeypatch.setattr(xtap_host.sys, 'stdout', fake_out)
    monkeypatch.setattr(xtap_host.os, 'makedirs', fail_makedirs)

    xtap_host.main()

    fake_out.buffer.seek(0)
    msg = _read_framed(fake_out.buffer)
    assert msg['ok'] is True
    assert msg['token'] == 'tok123'
    assert msg['port'] == xtap_host.XTAP_PORT
    assert call_count['makedirs'] == 0
