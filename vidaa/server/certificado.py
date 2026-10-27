"""Gera o certificado HTTPS do servidor (ECDSA P-256) com o openssl do Git Bash.

O certificado vale para vidaahub.com e www.vidaahub.com, nao e CA e dura 825 dias.
Ele fica em local/certs (fora do git) e nunca e importado no Windows.
"""
import os
import shutil
import subprocess
import sys

DAYS = 825
RENEW_BEFORE = 30 * 86400  # renova se faltar menos de 30 dias
GIT_OPENSSL = r"C:\Program Files\Git\usr\bin\openssl.exe"
NAMES = ("vidaahub.com", "www.vidaahub.com")


def find_openssl():
    """Prefere o openssl do Git; cai no que estiver no PATH."""
    if os.path.isfile(GIT_OPENSSL):
        return GIT_OPENSSL
    return shutil.which("openssl")


def _run(openssl, args):
    out = subprocess.run([openssl] + args, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError("openssl falhou: " + (out.stderr or out.stdout).strip())
    return out


def _valid(openssl, crt):
    """True se o certificado existe e ainda vale por mais de 30 dias."""
    res = subprocess.run(
        [openssl, "x509", "-in", crt, "-noout", "-checkend", str(RENEW_BEFORE)],
        capture_output=True, text=True)
    return res.returncode == 0


def ensure(cert_dir, force=False):
    """Devolve (crt, key); cria os dois se faltarem ou estiverem perto de vencer."""
    openssl = find_openssl()
    if not openssl:
        raise RuntimeError("openssl nao encontrado. Instale o Git for Windows.")
    os.makedirs(cert_dir, exist_ok=True)
    crt = os.path.join(cert_dir, "vidaahub.crt")
    key = os.path.join(cert_dir, "vidaahub.key")
    if not force and os.path.isfile(crt) and os.path.isfile(key) and _valid(openssl, crt):
        return crt, key
    san = ",".join("DNS:" + n for n in NAMES)
    _run(openssl, ["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", key])
    _run(openssl, [
        "req", "-new", "-x509", "-key", key, "-sha256", "-days", str(DAYS),
        "-subj", "/CN=" + NAMES[0],
        "-addext", "subjectAltName=" + san,
        "-addext", "basicConstraints=critical,CA:FALSE",
        "-addext", "keyUsage=critical,digitalSignature",
        "-addext", "extendedKeyUsage=serverAuth",
        "-out", crt])
    return crt, key


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "..", "..", "local", "certs")
    c, k = ensure(os.path.abspath(target), force="--force" in sys.argv)
    print("Certificado pronto:", c)
