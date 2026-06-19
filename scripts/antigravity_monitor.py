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
    
    prompt = (
        "=== AUDIT INSTRUCTIONS ===\n"
        "Perform an audit on the Meridian bot. The active project workspace is `/opt/meridian`.\n"
        "1. Read the config at `/opt/meridian/user-config.json`.\n"
        "2. Analyze decision logs and active PM2 runtime logs in `/opt/meridian/logs/`.\n"
        "3. Diagnose any anomalies (e.g., Meteora 429 rate limits, fast OOR exits, bad trades).\n"
        "4. If necessary, apply optimizations by updating `/opt/meridian/user-config.json` (using replace_file_content) and restarting the daemon (`pm2 restart meridian`).\n"
        "5. Output a structured status report summary. Keep tool calls and searches bounded to `/opt/meridian`.\n"
    )
    
    cmd = [
        "/home/angga/.local/bin/agy",
        "--dangerously-skip-permissions",
        "--print",
        prompt
    ]
    
    try:
        # Run with stdin ignored (equivalent to < /dev/null) to prevent hangs
        res = subprocess.run(
            cmd,
            env=clean_env,
            cwd="/opt/meridian",
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=300 # 5 minutes timeout
        )
        
        output = (res.stdout + "\n" + res.stderr).strip()
        if not output:
            output = f"No output received from Antigravity CLI. Exit code: {res.returncode}"
            
        print("Audit run finished. Sending report to Telegram...")
        send_telegram_message(output)
        
    except subprocess.TimeoutExpired:
        print("Antigravity CLI execution timed out.")
        send_telegram_message("⚠️ Antigravity CLI monitor execution timed out (5 minutes limit reached).")
    except Exception as e:
        print(f"Error running monitor: {e}")
        send_telegram_message(f"❌ Error running Antigravity CLI monitor: {str(e)}")

if __name__ == "__main__":
    main()
