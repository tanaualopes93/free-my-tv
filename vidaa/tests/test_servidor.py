"""Testes do servidor local (DNS seletivo, HTTPS, copias da lista).

Rode: python -m unittest vidaa/tests/test_servidor.py
Usa portas altas e uma pasta temporaria; nao mexe no servidor de verdade.
"""
import hashlib
import http.client
import json
import os
import shutil
import socket
import ssl
import struct
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

from dnslib import A, DNSRecord, QTYPE, RCODE, RR

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "server"))
import servidor  # noqa: E402

DNS_PORT, HTTPS_PORT, HTTP_PORT, UP_PORT, UP_DEAD = 15353, 18443, 18090, 15354, 15355
FAKE_IP = "9.9.9.9"
LIST = {"AppInfo": [{"Id": "1", "AppName": "Exemplo", "URL": "https://exemplo.test/"}]}


class FakeUpstream:
    """DNS de saida de mentira: responde A 9.9.9.9; 'grande.' trunca no UDP e completa no TCP."""

    def __init__(self, port):
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.bind(("127.0.0.1", port))
        self.tcp = socket.socket()
        self.tcp.bind(("127.0.0.1", port))
        self.tcp.listen(16)
        self.seen = {"udp": 0, "tcp": 0}
        self.closed = False
        threading.Thread(target=self.serve_udp, daemon=True).start()
        threading.Thread(target=self.serve_tcp, daemon=True).start()

    @staticmethod
    def make(packet, truncate):
        req = DNSRecord.parse(packet)
        rep = req.reply()
        if truncate:
            rep.header.tc = 1
        else:
            rep.add_answer(RR(req.q.qname, QTYPE.A, rdata=A(FAKE_IP), ttl=60))
        return rep.pack()

    def serve_udp(self):
        while not self.closed:
            try:
                data, addr = self.udp.recvfrom(4096)
            except OSError:
                return
            self.seen["udp"] += 1
            name = str(DNSRecord.parse(data).q.qname)
            self.udp.sendto(self.make(data, name.startswith("grande.")), addr)

    def serve_tcp(self):
        while not self.closed:
            try:
                conn, _ = self.tcp.accept()
            except OSError:
                return
            with conn:
                size = struct.unpack("!H", servidor.recv_exact(conn, 2))[0]
                data = servidor.recv_exact(conn, size)
                self.seen["tcp"] += 1
                out = self.make(data, False)
                conn.sendall(struct.pack("!H", len(out)) + out)

    def close(self):
        self.closed = True
        self.udp.close()
        self.tcp.close()


def udp_query(name, qtype="A", timeout=3):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.sendto(DNSRecord.question(name, qtype).pack(), ("127.0.0.1", DNS_PORT))
        return DNSRecord.parse(s.recvfrom(4096)[0])
    finally:
        s.close()


def tcp_query(name, qtype="A"):
    pkt = DNSRecord.question(name, qtype).pack()
    with socket.create_connection(("127.0.0.1", DNS_PORT), timeout=3) as s:
        s.sendall(struct.pack("!H", len(pkt)) + pkt)
        size = struct.unpack("!H", servidor.recv_exact(s, 2))[0]
        return DNSRecord.parse(servidor.recv_exact(s, size))


def https(method, path, body=None, raw=None):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    conn = http.client.HTTPSConnection("127.0.0.1", HTTPS_PORT, context=ctx, timeout=5)
    headers = {}
    if body is not None:
        raw = json.dumps(body)
    if raw is not None:
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=raw, headers=headers)
    res = conn.getresponse()
    data = res.read()
    conn.close()
    return res.status, data


def rdatas(record):
    return [str(x.rdata) for x in record.rr]


def make_config(tmp, subnet):
    return {
        "pc_ip": "10.1.2.3", "subnet": subnet,
        "upstream": ["127.0.0.1:%d" % UP_DEAD, "127.0.0.1:%d" % UP_PORT],
        "dns_port": DNS_PORT, "https_port": HTTPS_PORT, "http_port": HTTP_PORT,
        "backup_dir": os.path.join(tmp, "backups"), "store_dir": os.path.join(tmp, "out"),
        "cert_dir": os.path.join(tmp, "certs"), "log_dir": os.path.join(tmp, "logs"),
    }


class ServidorBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="fmtv-test-")
        os.makedirs(os.path.join(cls.tmp, "out", "store"))
        with open(os.path.join(cls.tmp, "out", "store", "ola.txt"), "w") as f:
            f.write("ola")
        with open(os.path.join(cls.tmp, "segredo.txt"), "w") as f:
            f.write("nao pode sair")
        cls.up = FakeUpstream(UP_PORT)
        cls.srv = servidor.Servidor(make_config(cls.tmp, "127.0.0.0/24"), bind="127.0.0.1")
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        cls.up.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)


class TestDNS(ServidorBase):
    def test_a_local(self):
        self.assertEqual(rdatas(udp_query("vidaahub.com")), ["10.1.2.3"])
        self.assertEqual(rdatas(udp_query("WWW.VidaaHub.com.")), ["10.1.2.3"])

    def test_aaaa_vazio(self):
        r = udp_query("vidaahub.com", "AAAA")
        self.assertEqual(r.header.rcode, RCODE.NOERROR)
        self.assertEqual(len(r.rr), 0)

    def test_encaminha_com_saida_morta_na_frente(self):
        self.assertEqual(rdatas(udp_query("exemplo.org")), [FAKE_IP])

    def test_tcp(self):
        self.assertEqual(rdatas(tcp_query("vidaahub.com")), ["10.1.2.3"])
        self.assertEqual(rdatas(tcp_query("exemplo.org")), [FAKE_IP])

    def test_truncamento_e_refaz_por_tcp(self):
        r = udp_query("grande.exemplo.org")
        self.assertEqual(r.header.tc, 1)
        self.assertEqual(len(r.rr), 0)
        full = tcp_query("grande.exemplo.org")
        self.assertEqual(full.header.tc, 0)
        self.assertEqual(rdatas(full), [FAKE_IP])

    def test_50_consultas_em_paralelo(self):
        def one(i):
            local = i % 2 == 1
            fn = tcp_query if i % 5 == 0 else udp_query
            name = "vidaahub.com" if local else "p%d.exemplo.org" % i
            return rdatas(fn(name)) == ["10.1.2.3" if local else FAKE_IP]
        with ThreadPoolExecutor(max_workers=50) as pool:
            self.assertTrue(all(pool.map(one, range(50))))

    def test_saida_fora_do_ar_da_servfail_e_nao_derruba(self):
        old = self.srv.ctx.cfg
        self.srv.ctx.cfg = dict(old, upstream=["127.0.0.1:%d" % UP_DEAD])
        try:
            self.assertEqual(udp_query("morto.exemplo.org", timeout=5).header.rcode, RCODE.SERVFAIL)
            self.assertEqual(rdatas(udp_query("vidaahub.com")), ["10.1.2.3"])
        finally:
            self.srv.ctx.cfg = old


class TestSubredeFora(unittest.TestCase):
    def test_ip_fora_da_subrede_e_ignorado(self):
        tmp = tempfile.mkdtemp(prefix="fmtv-test-")
        up = FakeUpstream(UP_PORT)
        srv = servidor.Servidor(make_config(tmp, "10.99.99.0/24"), bind="127.0.0.1")
        srv.start()
        try:
            with self.assertRaises(socket.timeout):
                udp_query("vidaahub.com", timeout=0.7)
            with self.assertRaises(socket.timeout):
                udp_query("exemplo.org", timeout=0.7)
            self.assertEqual(srv.ctx.stats.snapshot()["ignoradas"], 2)
            self.assertEqual(up.seen["udp"], 0)
        finally:
            srv.stop()
            up.close()
            shutil.rmtree(tmp, ignore_errors=True)


class TestHTTPS(ServidorBase):
    def test_ping(self):
        code, data = https("GET", "/ping")
        self.assertEqual(code, 200)
        self.assertTrue(json.loads(data)["ok"])

    def test_certificado_so_vidaahub_e_nao_ca(self):
        crt = os.path.join(self.srv.cfg["cert_dir"], "vidaahub.crt")
        cert = servidor.certificado
        out = cert._run(cert.find_openssl(), ["x509", "-in", crt, "-noout", "-text"]).stdout
        self.assertIn("DNS:vidaahub.com, DNS:www.vidaahub.com", out)
        self.assertIn("CA:FALSE", out)
        self.assertIn("prime256v1", out)

    def test_backup_valido_lista_e_le(self):
        raw = json.dumps(LIST)
        code, data = https("POST", "/backup", {"raw": raw, "reason": "teste"})
        self.assertEqual(code, 200)
        res = json.loads(data)
        self.assertEqual(res["sha256"], hashlib.sha256(raw.encode()).hexdigest())
        self.assertTrue(os.path.isfile(os.path.join(self.srv.cfg["backup_dir"], res["file"] + ".sha256")))
        code, data = https("GET", "/backups")
        item = [x for x in json.loads(data) if x["file"] == res["file"]][0]
        self.assertEqual((item["apps"], item["sha256"]), (1, res["sha256"]))
        code, data = https("GET", "/backups/" + res["file"])
        self.assertEqual(data.decode(), raw)

    def test_backup_invalido(self):
        for body in ({"raw": "nao e json"}, {"raw": "[]"}, {"raw": '{"AppInfo":3}'}, {"reason": "x"}, [1]):
            self.assertEqual(https("POST", "/backup", body)[0], 400, body)
        self.assertEqual(https("POST", "/backup", raw="{quebrado")[0], 400)
        big = {"raw": json.dumps({"AppInfo": []}) + " " * (300 * 1024)}
        self.assertEqual(https("POST", "/backup", big)[0], 413)

    def test_backup_nao_guarda_a_chave_do_tmdb(self):
        raw = json.dumps({"AppInfo": [{"Id": "FreeMyTV", "URL": "https://x.example/#k=SECRETKEY123"}]})
        code, data = https("POST", "/backup", {"raw": raw, "reason": "a\nFAKE"})
        self.assertEqual(code, 200)
        file = json.loads(data)["file"]
        with open(os.path.join(self.srv.cfg["backup_dir"], file), encoding="utf-8") as f:
            saved = f.read()
        self.assertNotIn("SECRETKEY123", saved)
        self.assertIn("#k=", saved)
        self.assertEqual(servidor.apps_in(saved), 1)

    def test_backups_nome_com_quebra_de_linha(self):
        self.assertEqual(https("GET", "/backups/lista-20260101-010101.json%0a")[0], 404)

    def test_backups_nome_estranho(self):
        for name in ("..%2F..%2Fsegredo.txt", "lista-1.json", "x.json"):
            self.assertEqual(https("GET", "/backups/" + name)[0], 404)

    def test_log(self):
        self.assertEqual(https("POST", "/log", {"evento": "oi"})[0], 200)
        folder = os.path.join(self.tmp, "logs")
        name = os.listdir(folder)[0]
        self.assertTrue(name.startswith("tv-") and name.endswith(".jsonl"))
        with open(os.path.join(folder, name), encoding="utf-8") as f:
            self.assertEqual(json.loads(f.readline())["data"], {"evento": "oi"})

    def test_store_serve_e_bloqueia_traversal(self):
        self.assertEqual(https("GET", "/store/ola.txt"), (200, b"ola"))
        for path in ("/store/../../segredo.txt", "/store/..%2F..%2Fsegredo.txt",
                     "/store/%2e%2e/segredo.txt", "/store/..%5C..%5Csegredo.txt",
                     "/store/..%2f..%2fsegredo.txt", "/store/nao-existe"):
            code, data = https("GET", path)
            self.assertEqual(code, 404, path)
            self.assertNotIn(b"nao pode sair", data)

    def test_raiz_nao_quebra(self):
        self.assertIn(https("GET", "/")[0], (200, 404))

    def test_http_redireciona_e_mostra_ajuda(self):
        c = http.client.HTTPConnection("127.0.0.1", HTTP_PORT, timeout=3)
        c.request("GET", "/", headers={"Host": "vidaahub.com"})
        r = c.getresponse()
        r.read()
        self.assertEqual((r.status, r.getheader("Location")), (301, "https://vidaahub.com/"))
        c.close()
        c = http.client.HTTPConnection("127.0.0.1", HTTP_PORT, timeout=3)
        c.request("GET", "/")
        self.assertIn("10.1.2.3", c.getresponse().read().decode())
        c.close()


if __name__ == "__main__":
    unittest.main()
