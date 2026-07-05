import os
import subprocess
import urllib.request
import urllib.parse
from dotenv import load_dotenv

# Load environment variables from the Meridian .env file
load_dotenv("/opt/meridian/.env")

def send_telegram_message(text: str):
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        print("Telegram configuration missing. Skipping status report notification.")
        return
        
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    
    # Telegram max message length is 4096
    if len(text) > 4000:
        text = text[:3900] + "\n\n... (truncated)"
        
    # Escape underscores to prevent Telegram Markdown parsing errors
    escaped_text = text.replace("_", "\\_")
    
    data = urllib.parse.urlencode({
        "chat_id": chat_id,
        "text": escaped_text,
        "parse_mode": "Markdown"
    }).encode("utf-8")
    
    try:
        req = urllib.request.Request(url, data=data)
        urllib.request.urlopen(req)
        print("Successfully sent status report to Telegram.")
    except Exception as e:
        print(f"Failed to send Telegram message with Markdown formatting: {e}. Retrying as plain text...")
        try:
            data_plain = urllib.parse.urlencode({
                "chat_id": chat_id,
                "text": text
            }).encode("utf-8")
            req = urllib.request.Request(url, data=data_plain)
            urllib.request.urlopen(req)
            print("Successfully sent status report as plain text.")
        except Exception as e_plain:
            print(f"Failed to send Telegram message as plain text: {e_plain}")

def main():
    print("Starting autonomous Meridian bot audit via Antigravity CLI...")
    
    # Run the agy CLI as a subprocess to use the keyring OAuth Ultra plan quota
    clean_env = os.environ.copy()
    clean_env.pop("GEMINI_API_KEY", None)
    clean_env.pop("LLM_API_KEY", None)
    
    # ADVISORY-ONLY since 2026-07-05. This monitor used to apply config "optimizations"
    # autonomously (step 4) — retired after it enabled crashFastPathEnabled from stale
    # premises with no audit trail. Config changes go through the human (/setcfg) or the
    # native evolution engine, which is closed-loop and self-reverting.
    prompt = (
        "=== AUDIT INSTRUCTIONS (READ-ONLY — ADVISORY) ===\n"
        "Perform a READ-ONLY audit of the Meridian bot. The active project workspace is `/opt/meridian`.\n"
        "1. Read the config at `/opt/meridian/user-config.json`.\n"
        "2. Analyze decision logs and active PM2 runtime logs in `/opt/meridian/logs/`.\n"
        "3. Diagnose any anomalies (e.g., Meteora 429 rate limits, fast OOR exits, bad trades).\n"
        "4. You MUST NOT modify any file, run pm2, or change any config. If you believe a config\n"
        "   change would help, OUTPUT it as a recommendation with: the key, current value, proposed\n"
        "   value, and the specific log/data evidence — the human applies it via Telegram /setcfg.\n"
        "5. Output a structured status report summary prefixed with 'ADVISORY (no changes applied)'.\n"
        "   Keep tool calls and searches bounded to `/opt/meridian`.\n"
    )
    
    cmd = [
        "/home/angga/.local/bin/agy",
        "--dangerously-skip-permissions",
        "--print",
        prompt
    ]
    
    try:
        # Run with stdin ignored (equivalent to < /dev/null) to prevent hangs.
        # 15 minutes: the prompt involves reading config, scanning logs, diagnosing
        # anomalies, and optionally rewriting config + restarting PM2 — many LLM
        # tool-call round-trips that can easily exceed 5 min on a loaded VM.
        proc = subprocess.Popen(
            cmd,
            env=clean_env,
            cwd="/opt/meridian",
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            stdout, stderr = proc.communicate(timeout=900)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            partial = (stdout + "\n" + stderr).strip()
            msg = "⚠️ Antigravity CLI monitor timed out (15 min limit)."
            if partial:
                msg += f"\n\nPartial output before timeout:\n{partial[:2000]}"
            print("Antigravity CLI execution timed out.")
            send_telegram_message(msg)
            return

        output = (stdout + "\n" + stderr).strip()
        if not output:
            output = f"No output received from Antigravity CLI. Exit code: {proc.returncode}"

        print("Audit run finished. Sending report to Telegram...")
        send_telegram_message(output)
    except Exception as e:
        print(f"Error running monitor: {e}")
        send_telegram_message(f"❌ Error running Antigravity CLI monitor: {str(e)}")

if __name__ == "__main__":
    main()
