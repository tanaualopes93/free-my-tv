"""Servidor local do Free My TV para a VIDAA.

- DNS seletivo (UDP e TCP): so vidaahub.com aponta para este PC, o resto segue adiante.
- HTTPS: serve o instalador (vidaa/shell), a Loja (out/vidaa/store) e guarda as copias da lista de apps.
- HTTP: so redireciona ou mostra uma pagina de ajuda.

Uso: python vidaa/server/servidor.py   (precisa de dnslib; portas 53 e 443 pedem administrador)
"""
import argparse
import ctypes
import hashlib
import ipaddress
import json
import mimetypes
import os
import re
import socket
import socketserver
import ssl
import struct
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

from dnslib import A, DNSRecord, QTYPE, RCODE, RR

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import certificado  # noqa: E402

VERSION = "0.1.0"
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
LOCAL_NAMES = ("vidaahub.com", "www.vidaahub.com")
UPSTREAM_TIMEOUT = 1.5
MAX_BODY = 256 * 1024
BACKUP_NAME = re.compile(r"lista-\d{8}-\d{6}(-\d+)?\.json")
KEY_IN_URL = re.compile(r'#k=[^"\\\s]*')   # the TMDB key rides in the app address; copies never keep it
MAX_BACKUPS = 200
MAX_LOG_BYTES = 5 * 1024 * 1024
ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("font/woff2", ".woff2")


# ---------- configuracao ----------

def detect_ip():
    """IP do PC na rota padrao (nao envia nada pela rede)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


def default_config():
    ip = detect_ip()
    return {
        "pc_ip": ip,
        "subnet": str(ipaddress.ip_network(ip + "/24", strict=False)),
        "upstream": ["1.1.1.1", "8.8.8.8"],
        "dns_port": 53,
        "https_port": 443,
        "http_port": 8080,
        "backup_dir": "D:\\Backups\\free-my-tv-vidaa",
        "store_dir": "out/vidaa",
        "cert_dir": "local/certs",
    }


def load_config(path):
    """Le o JSON; na primeira execucao cria o arquivo com o IP detectado."""
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
        base = default_config() if "pc_ip" not in cfg or "subnet" not in cfg else {}
        base.update(cfg)
        return base
    cfg = default_config()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    print("Primeira execucao: criei %s com o IP %s." % (path, cfg["pc_ip"]))
    return cfg


def absolute(path):
    return path if os.path.isabs(path) else os.path.join(ROOT, path)


def parse_upstream(item):
    """'1.1.1.1' ou '127.0.0.1:15354' -> (host, port)."""
    host, _, port = str(item).partition(":")
    return host, int(port or 53)


# ---------- DNS ----------

class Stats:
    def __init__(self):
        self.lock = threading.Lock()
        self.count = {"local": 0, "encaminhadas": 0, "falhas": 0, "ignoradas": 0}

    def add(self, key):
        with self.lock:
            self.count[key] += 1

    def snapshot(self):
        with self.lock:
            return dict(self.count)


def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("conexao fechada")
        buf += chunk
    return buf


def ask_upstream(packet, upstream, tcp):
    """Pergunta aos DNS de saida em ordem; devolve a resposta crua ou None."""
    for item in upstream:
        host, port = parse_upstream(item)
        try:
            if tcp:
                with socket.create_connection((host, port), timeout=UPSTREAM_TIMEOUT) as s:
                    s.settimeout(UPSTREAM_TIMEOUT)
                    s.sendall(struct.pack("!H", len(packet)) + packet)
                    size = struct.unpack("!H", recv_exact(s, 2))[0]
                    answer = recv_exact(s, size)
            else:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                    s.settimeout(UPSTREAM_TIMEOUT)
                    s.sendto(packet, (host, port))
                    answer, _ = s.recvfrom(65535)
            if answer[:2] == packet[:2]:
                return answer
        except (OSError, struct.error):
            continue
    return None


def answer_dns(packet, ctx, tcp):
    """Monta a resposta crua para uma consulta, ou None para ignorar."""
    try:
        req = DNSRecord.parse(packet)
    except Exception:
        return None
    if req.header.qr == 1 or not req.questions:
        return None
    q = req.q
    name = str(q.qname).rstrip(".").lower()
    if name in LOCAL_NAMES:
        reply = req.reply()
        if q.qtype == QTYPE.A:
            reply.add_answer(RR(q.qname, QTYPE.A, rdata=A(ctx.cfg["pc_ip"]), ttl=30))
        ctx.stats.add("local")
        return reply.pack()
    answer = ask_upstream(packet, ctx.cfg["upstream"], tcp)
    if answer is not None:
        ctx.stats.add("encaminhadas")
        return answer
    ctx.stats.add("falhas")
    reply = req.reply()
    reply.header.rcode = RCODE.SERVFAIL
    return reply.pack()


class Context:
    """O que os handlers compartilham."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.net = ipaddress.ip_network(cfg["subnet"], strict=False)
        self.stats = Stats()

    def allowed(self, ip):
        try:
            return ipaddress.ip_address(ip) in self.net
        except ValueError:
            return False


class UDPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        ctx = self.server.ctx
        if not ctx.allowed(self.client_address[0]):
            ctx.stats.add("ignoradas")
            return
        answer = answer_dns(data, ctx, False)
        if answer:
            sock.sendto(answer, self.client_address)


class TCPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        ctx = self.server.ctx
        if not ctx.allowed(self.client_address[0]):
            ctx.stats.add("ignoradas")
            return
        self.request.settimeout(5)
        try:
            while True:
                size = struct.unpack("!H", recv_exact(self.request, 2))[0]
                answer = answer_dns(recv_exact(self.request, size), ctx, True)
                if answer is None:
                    return
                self.request.sendall(struct.pack("!H", len(answer)) + answer)
        except (OSError, struct.error):
            return


class DNSUDPServer(socketserver.ThreadingUDPServer):
    daemon_threads = True
    allow_reuse_address = os.name != "nt"


class DNSTCPServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = os.name != "nt"
    request_queue_size = 64


# ---------- HTTPS e HTTP ----------

def safe_join(base, rel):
    """Caminho dentro de base, ou None se tentar sair dela."""
    rel = unquote(rel)
    if "\x00" in rel or "\\" in rel:
        return None
    base = os.path.realpath(base)
    path = os.path.realpath(os.path.join(base, *[p for p in rel.split("/") if p]))
    if path != base and not path.startswith(base + os.sep):
        return None
    return path


def apps_in(raw):
    """Quantidade de apps de uma lista, ou None se nao for uma lista valida."""
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if isinstance(data, dict) and isinstance(data.get("AppInfo"), list):
        return len(data["AppInfo"])
    return None


HELP_PAGE = """<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Free My TV</title>
<style>body{font:18px/1.5 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#1c1c1e}
code{background:#eee;padding:2px 6px;border-radius:6px}</style>
<h1>Servidor do Free My TV</h1>
<p>Este PC esta pronto. Na TV, troque o DNS da rede para <code>%(ip)s</code> e abra o navegador em
<code>https://vidaahub.com</code>.</p>
<ol><li>Na TV: Configuracoes, Rede, DNS manual, digite <code>%(ip)s</code>.</li>
<li>Abra o aplicativo do navegador e va em vidaahub.com.</li>
<li>Siga as telas. No fim, volte o DNS para automatico.</li></ol></html>"""


class WebHandler(BaseHTTPRequestHandler):
    server_version = "FreeMyTV/" + VERSION
    protocol_version = "HTTP/1.1"
    timeout = 15   # a stalled client must not hold a thread forever

    def log_message(self, fmt, *args):
        pass

    # respostas
    def send_bytes(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, code, obj):
        self.send_bytes(code, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    def send_file(self, path):
        if not path or not os.path.isfile(path):
            return self.send_json(404, {"ok": False, "error": "nao encontrado"})
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        with open(path, "rb") as f:
            self.send_bytes(200, f.read(), ctype)

    def read_json(self):
        """Corpo JSON de ate 256 KB; devolve (obj, None) ou (None, erro ja enviado)."""
        try:
            size = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send_json(411, {"ok": False, "error": "falta Content-Length"})
            return None
        if size < 0 or size > MAX_BODY:
            # le e descarta (ate 4 MB) para o cliente conseguir ver a resposta
            left = min(max(size, 0), 4 * 1024 * 1024)
            while left > 0:
                chunk = self.rfile.read(min(left, 65536))
                if not chunk:
                    break
                left -= len(chunk)
            self.send_json(413, {"ok": False, "error": "corpo maior que 256 KB"})
            self.close_connection = True
            return None
        body = self.rfile.read(size)
        try:
            return json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self.send_json(400, {"ok": False, "error": "JSON invalido"})
            return None

    def blocked(self):
        ctx = self.server.ctx
        ip = self.client_address[0]
        if ctx.allowed(ip) or ip in ("127.0.0.1", "::1"):
            return False
        self.send_json(403, {"ok": False, "error": "fora da rede"})
        return True


class HTTPSHandler(WebHandler):
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if self.blocked():
            return
        ctx = self.server.ctx
        path = urlsplit(self.path).path
        if path == "/" or path == "/index.html":
            return self.send_file(os.path.join(ROOT, "vidaa", "shell", "index.html"))
        if path == "/ping":
            return self.send_json(200, {"ok": True, "version": VERSION, "ip": ctx.cfg["pc_ip"]})
        if path.startswith("/shell/"):
            return self.send_file(safe_join(os.path.join(ROOT, "vidaa", "shell"), path[7:]))
        if path.startswith("/store/"):
            store = os.path.join(absolute(ctx.cfg["store_dir"]), "store")
            return self.send_file(safe_join(store, path[7:]))
        if path == "/backups":
            return self.list_backups()
        if path.startswith("/backups/"):
            name = unquote(path[9:])
            if not BACKUP_NAME.fullmatch(name):
                return self.send_json(404, {"ok": False, "error": "nao encontrado"})
            return self.send_file(os.path.join(absolute(ctx.cfg["backup_dir"]), name))
        self.send_json(404, {"ok": False, "error": "nao encontrado"})

    def do_POST(self):
        if self.blocked():
            return
        path = urlsplit(self.path).path
        if path == "/backup":
            return self.save_backup()
        if path == "/log":
            return self.save_log()
        self.send_json(404, {"ok": False, "error": "nao encontrado"})

    def save_backup(self):
        data = self.read_json()
        if data is None:
            return
        raw = data.get("raw") if isinstance(data, dict) else None
        if not isinstance(raw, str) or apps_in(raw) is None:
            return self.send_json(400, {"ok": False, "error": "raw precisa ser a lista com AppInfo"})
        folder = absolute(self.server.ctx.cfg["backup_dir"])
        os.makedirs(folder, exist_ok=True)
        if sum(1 for n in os.listdir(folder) if BACKUP_NAME.fullmatch(n)) >= MAX_BACKUPS:
            return self.send_json(507, {"ok": False, "error": "muitas copias; apague as mais antigas"})
        raw = KEY_IN_URL.sub("#k=", raw)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        name, n = "lista-%s.json" % stamp, 1
        with self.server.lock:
            while os.path.exists(os.path.join(folder, name)):
                n += 1
                name = "lista-%s-%d.json" % (stamp, n)
            content = raw.encode("utf-8")
            digest = hashlib.sha256(content).hexdigest()
            with open(os.path.join(folder, name), "wb") as f:
                f.write(content)
            with open(os.path.join(folder, name + ".sha256"), "w", encoding="ascii") as f:
                f.write("%s  %s\n" % (digest, name))
        reason = re.sub(r"[^\w .-]", "_", str(data.get("reason", ""))[:80])
        print("Copia da lista guardada: %s (%s)" % (name, reason or "sem motivo"))
        self.send_json(200, {"ok": True, "file": name, "sha256": digest})

    def list_backups(self):
        folder = absolute(self.server.ctx.cfg["backup_dir"])
        items = []
        if os.path.isdir(folder):
            for name in sorted(os.listdir(folder), reverse=True):
                if not BACKUP_NAME.fullmatch(name):
                    continue
                full = os.path.join(folder, name)
                with open(full, "rb") as f:
                    content = f.read()
                items.append({
                    "file": name,
                    "sha256": hashlib.sha256(content).hexdigest(),
                    "apps": apps_in(content.decode("utf-8", "replace")),
                    "when": datetime.fromtimestamp(os.path.getmtime(full)).isoformat(timespec="seconds"),
                })
        self.send_json(200, items)

    def save_log(self):
        data = self.read_json()
        if data is None:
            return
        folder = absolute("local/logs") if not self.server.ctx.cfg.get("log_dir") \
            else absolute(self.server.ctx.cfg["log_dir"])
        os.makedirs(folder, exist_ok=True)
        now = datetime.now()
        line = json.dumps({"t": now.isoformat(timespec="seconds"), "data": data}, ensure_ascii=False)
        target = os.path.join(folder, "tv-%s.jsonl" % now.strftime("%Y%m%d"))
        with self.server.lock:
            if os.path.exists(target) and os.path.getsize(target) > MAX_LOG_BYTES:
                return self.send_json(507, {"ok": False, "error": "log cheio por hoje"})
            with open(target, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        self.send_json(200, {"ok": True})


class HTTPHandler(WebHandler):
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if self.blocked():
            return
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        if host in LOCAL_NAMES:
            return self.send_bytes(301, b"", "text/plain", {"Location": "https://%s%s" % (host, self.path)})
        page = HELP_PAGE % {"ip": self.server.ctx.cfg["pc_ip"]}
        self.send_bytes(200, page.encode("utf-8"), "text/html; charset=utf-8")


class WebServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = os.name != "nt"
    request_queue_size = 64

    def __init__(self, addr, handler, ctx):
        super().__init__(addr, handler)
        self.ctx = ctx
        self.lock = threading.Lock()


# ---------- conjunto ----------

class Servidor:
    """Sobe e derruba DNS, HTTPS e HTTP. Usado pelo main e pelos testes."""

    def __init__(self, cfg, bind="0.0.0.0"):
        self.cfg = cfg
        self.bind = bind
        self.ctx = Context(cfg)
        self.servers = []

    def start(self):
        cfg, ctx = self.cfg, self.ctx
        crt, key = certificado.ensure(absolute(cfg["cert_dir"]))
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.minimum_version = ssl.TLSVersion.TLSv1_2
        tls.load_cert_chain(crt, key)

        udp = DNSUDPServer((self.bind, cfg["dns_port"]), UDPHandler)
        tcp = DNSTCPServer((self.bind, cfg["dns_port"]), TCPHandler)
        udp.ctx = tcp.ctx = ctx
        https = WebServer((self.bind, cfg["https_port"]), HTTPSHandler, ctx)
        https.socket = tls.wrap_socket(https.socket, server_side=True)
        http = WebServer((self.bind, cfg["http_port"]), HTTPHandler, ctx)
        self.servers = [udp, tcp, https, http]
        for srv in self.servers:
            threading.Thread(target=srv.serve_forever, daemon=True).start()

    def stop(self):
        for srv in self.servers:
            srv.shutdown()
            srv.server_close()
        self.servers = []


def keep_awake(on):
    """Impede a suspensao do Windows enquanto o servidor roda."""
    try:
        flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED if on else ES_CONTINUOUS
        ctypes.windll.kernel32.SetThreadExecutionState(flags)
    except (AttributeError, OSError):
        pass


def main(argv=None):
    ap = argparse.ArgumentParser(description="Servidor local do Free My TV (VIDAA)")
    ap.add_argument("--config", default=os.path.join(ROOT, "local", "servidor.json"))
    ap.add_argument("--dns-port", type=int)
    ap.add_argument("--https-port", type=int)
    ap.add_argument("--http-port", type=int)
    args = ap.parse_args(argv)

    cfg = load_config(args.config)
    for key in ("dns_port", "https_port", "http_port"):
        if getattr(args, key) is not None:
            cfg[key] = getattr(args, key)

    # "bind": the PC's address only, when Windows ICS already holds 0.0.0.0:53
    srv = Servidor(cfg, cfg.get("bind") or "0.0.0.0")
    try:
        srv.start()
    except PermissionError:
        print("Sem permissao para abrir as portas. Abra o terminal como administrador.")
        return 1
    except OSError as e:
        print("Nao consegui abrir as portas (%s). Tem outro servidor rodando?" % e)
        return 1
    except RuntimeError as e:
        print("Erro: %s" % e)
        return 1

    keep_awake(True)
    print("Servidor do Free My TV no ar (versao %s)." % VERSION)
    print("IP deste PC: %s   Rede liberada: %s" % (cfg["pc_ip"], cfg["subnet"]))
    print("Proximos passos:")
    print("  1. Na TV, coloque o DNS manual em %s." % cfg["pc_ip"])
    print("  2. Abra o navegador da TV em https://vidaahub.com")
    print("  3. No fim, volte o DNS para automatico e tire a TV da tomada por 10 s.")
    print("Deixe esta janela aberta. Para parar: Ctrl+C.")
    last = None
    try:
        while True:
            time.sleep(60)
            snap = srv.ctx.stats.snapshot()
            if snap != last:
                print("[%s] consultas: %s" % (datetime.now().strftime("%H:%M"), snap))
                last = snap
    except KeyboardInterrupt:
        print("\nParando.")
    finally:
        srv.stop()
        keep_awake(False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
