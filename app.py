import os
import io
import sqlite3
from datetime import datetime
from functools import wraps
from flask import (
    Flask,
    render_template,
    request,
    redirect,
    url_for,
    session,
    flash,
    jsonify,
    g
)
from werkzeug.security import generate_password_hash, check_password_hash
import pymupdf as fitz
from PIL import Image
import pytesseract
import pdf2image

# Configure Tesseract default Windows path
TESSERACT_EXE = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
if os.path.exists(TESSERACT_EXE):
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_EXE

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dyslexilens_calm_pastel_secret_key_2026")
DATABASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dyslexilens.db")


def get_db():
    """Opens a new database connection if there is none yet for the current application context."""
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
        # Ensure tables exist even if the DB file was created or wiped
        init_db()
    return g.db


@app.teardown_appcontext
def close_db(exception):
    """Closes the database again at the end of the request."""
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    """Initializes the database tables."""
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()

    # Users table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Login history table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS login_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            logout_time TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    """)

    conn.commit()
    conn.close()


# Initialize database when module is loaded
init_db()


def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if "user_id" not in session:
            flash("Please log in to access your DyslexiLens space.", "info")
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated_function


@app.route("/")
def index():
    if "user_id" in session:
        return redirect(url_for("home"))
    return redirect(url_for("login"))


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if "user_id" in session:
        return redirect(url_for("home"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        email = request.form.get("email", "").strip()
        password = request.form.get("password", "")

        # Basic validations
        if not username or not email or not password:
            flash("All fields are required. Please fill in all details.", "error")
            return render_template("signup.html", username=username, email=email)

        if len(username) < 3:
            flash("Username must be at least 3 characters long.", "error")
            return render_template("signup.html", username=username, email=email)

        if len(password) < 6:
            flash("Password must be at least 6 characters long.", "error")
            return render_template("signup.html", username=username, email=email)

        db = get_db()
        cursor = db.cursor()

        # Check existing user
        cursor.execute("SELECT id FROM users WHERE username = ? OR email = ?", (username, email))
        existing_user = cursor.fetchone()
        if existing_user:
            flash("A user with this username or email already exists. Try logging in!", "error")
            return render_template("signup.html", username=username, email=email)

        # Hash password securely with werkzeug.security
        hashed_password = generate_password_hash(password)
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        try:
            cursor.execute(
                "INSERT INTO users (username, email, password, created_at) VALUES (?, ?, ?, ?)",
                (username, email, hashed_password, now_str)
            )
            db.commit()
            flash("Account created successfully! You can now log in.", "success")
            return redirect(url_for("login"))
        except sqlite3.Error as e:
            flash(f"An error occurred while creating your account: {e}", "error")
            return render_template("signup.html", username=username, email=email)

    return render_template("signup.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if "user_id" in session:
        return redirect(url_for("home"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        if not username or not password:
            flash("Please enter both username and password.", "error")
            return render_template("login.html", username=username)

        db = get_db()
        cursor = db.cursor()
        cursor.execute("SELECT * FROM users WHERE username = ?", (username,))
        user = cursor.fetchone()

        if user and check_password_hash(user["password"], password):
            # Record login in login_history table
            login_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            cursor.execute(
                "INSERT INTO login_history (user_id, login_time) VALUES (?, ?)",
                (user["id"], login_time)
            )
            db.commit()
            history_id = cursor.lastrowid

            # Set session variables
            session["user_id"] = user["id"]
            session["username"] = user["username"]
            session["email"] = user["email"]
            session["login_history_id"] = history_id

            flash(f"Welcome back, {user['username']}! Enjoy your calm reading session.", "success")
            return redirect(url_for("home"))
        else:
            flash("Invalid username or password. Please try again.", "error")
            return render_template("login.html", username=username)

    return render_template("login.html")


@app.route("/logout")
def logout():
    # Record logout_time in login_history for the current session
    history_id = session.get("login_history_id")
    if history_id:
        try:
            db = get_db()
            cursor = db.cursor()
            logout_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            cursor.execute(
                "UPDATE login_history SET logout_time = ? WHERE id = ?",
                (logout_time, history_id)
            )
            db.commit()
        except sqlite3.Error:
            pass

    # Clear Flask session
    session.clear()
    flash("You have been logged out safely. See you again soon!", "info")
    return redirect(url_for("login"))


def extract_text_from_file(file_storage):
    """Extracts text from PDF, JPG, or PNG files using PyMuPDF and pytesseract OCR."""
    filename = file_storage.filename or ""
    ext = os.path.splitext(filename)[1].lower()
    file_bytes = file_storage.read()

    if not file_bytes:
        return False, "The uploaded file is empty. Please select a valid document."

    if ext not in [".pdf", ".jpg", ".jpeg", ".png"]:
        return False, "Unsupported file format. Please upload a PDF, JPG, or PNG document."

    extracted_text = ""

    if ext == ".pdf":
        try:
            # 1. First attempt: Direct digital text extraction with PyMuPDF
            doc = fitz.open(stream=file_bytes, filetype="pdf")
            text_parts = []
            for page in doc:
                text_parts.append(page.get_text())
            text = "\n\n".join(p.strip() for p in text_parts if p.strip())

            # 2. Fall back to OCR if digital text is empty or very short (< 15 chars)
            if len(text.strip()) >= 15:
                extracted_text = text
            else:
                # Scanned PDF: convert pages to images
                images = []
                try:
                    # Attempt pdf2image first (requires poppler)
                    images = pdf2image.convert_from_bytes(file_bytes)
                except Exception:
                    # Fallback using PyMuPDF pixmap rendering to guarantee image conversion without Poppler
                    images = []
                    for page in doc:
                        pix = page.get_pixmap(dpi=150)
                        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                        images.append(img)

                ocr_parts = []
                for img in images:
                    txt = pytesseract.image_to_string(img)
                    if txt.strip():
                        ocr_parts.append(txt.strip())
                extracted_text = "\n\n".join(ocr_parts)

        except Exception as e:
            return False, f"Failed to extract text from PDF: {e}"

    elif ext in [".jpg", ".jpeg", ".png"]:
        try:
            img = Image.open(io.BytesIO(file_bytes))
            extracted_text = pytesseract.image_to_string(img).strip()
        except Exception as e:
            return False, f"OCR extraction failed: {e}"

    if not extracted_text or not extracted_text.strip():
        return False, "No readable text could be found or extracted from the uploaded document."

    return True, extracted_text.strip()


@app.route("/upload", methods=["POST"])
@login_required
def upload_file():
    if "document" not in request.files:
        flash("No file was selected for upload.", "error")
        if request.headers.get("X-Requested-With") == "XMLHttpRequest":
            return jsonify({"success": False, "error": "No file selected."}), 400
        return redirect(url_for("home"))

    file = request.files["document"]
    if file.filename == "":
        flash("Please select a file to upload.", "error")
        if request.headers.get("X-Requested-With") == "XMLHttpRequest":
            return jsonify({"success": False, "error": "No file selected."}), 400
        return redirect(url_for("home"))

    success, result = extract_text_from_file(file)

    if not success:
        flash(result, "error")
        if request.headers.get("X-Requested-With") == "XMLHttpRequest":
            return jsonify({"success": False, "error": result}), 400
        return redirect(url_for("home"))

    flash(f"Document '{file.filename}' processed successfully! Text loaded into reading sandbox.", "success")
    session["extracted_text"] = result
    session["extracted_filename"] = file.filename

    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        return jsonify({"success": True, "text": result, "filename": file.filename})

    return redirect(url_for("home"))


@app.route("/home")
@login_required
def home():
    user_id = session["user_id"]
    db = get_db()
    cursor = db.cursor()

    # Fetch user info
    cursor.execute("SELECT id, username, email, created_at FROM users WHERE id = ?", (user_id,))
    user = cursor.fetchone()

    # Fetch login history (most recent 10 sessions)
    cursor.execute("""
        SELECT id, login_time, logout_time 
        FROM login_history 
        WHERE user_id = ? 
        ORDER BY id DESC 
        LIMIT 10
    """, (user_id,))
    history_records = cursor.fetchall()

    extracted_text = session.pop("extracted_text", None)
    extracted_filename = session.pop("extracted_filename", None)

    return render_template(
        "home.html",
        user=user,
        history=history_records,
        current_history_id=session.get("login_history_id"),
        extracted_text=extracted_text,
        extracted_filename=extracted_filename
    )


if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=5000)