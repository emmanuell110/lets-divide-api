// Backend mínimo para Let's Divide (1 archivo)
// Endpoints: /register, /login, /me, /progress, /video-view
import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// ====== Config ======
const {
  PORT = 3000,
  JWT_SECRET = "teamomiamorkeyla",
  DB_HOST = "localhost",
  DB_USER = "divideuser",
  DB_PASS = "divide123",
  DB_NAME = "dividivertido",
  DB_PORT = 3306
} = process.env;

// ====== DB Pool ======
const pool = mysql.createPool({
  host: DB_HOST, user: DB_USER, password: DB_PASS, database: DB_NAME, port: Number(DB_PORT),
  waitForConnections: true, connectionLimit: 10
});

// ====== App ======
const app = express();
app.use(cors()); // en producción puedes limitar origin: { origin: ["https://tu-front.vercel.app"] }
app.use(express.json());

// ====== Helpers ======
const sign = (id) => jwt.sign({ id }, JWT_SECRET, { expiresIn: "7d" });

const auth = async (req, res, next) => {
  try {
    const hdr = req.headers.authorization || "";
    const [, token] = hdr.split(" ");
    if (!token) return res.status(401).json({ error: "No token" });
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    next();
  } catch {
    res.status(401).json({ error: "Token inválido" });
  }
};

const getProfile = async (userId) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.username, u.edad,
            COALESCE(e.progreso_general,0) AS progreso_general,
            COALESCE(e.progreso_nivel_actual,0) AS progreso_nivel_actual,
            COALESCE(e.nivel_actual,1) AS nivel_actual,
            COALESCE(e.problemas_completados,0) AS problemas_completados,
            COALESCE(e.aciertos,0) AS aciertos,
            COALESCE(e.fallos,0) AS fallos
     FROM usuarios u
     LEFT JOIN estadisticas e ON u.id = e.usuario_id
     WHERE u.id = ?`,
    [userId]
  );
  return rows[0];
};

// ====== Rutas ======
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/register", async (req, res) => {
  try {
    const { username, password, age } = req.body;
    if (!username || !password || !age) return res.status(400).json({ error: "Faltan campos" });

    const [exists] = await pool.query("SELECT id FROM usuarios WHERE username = ?", [username]);
    if (exists.length) return res.status(409).json({ error: "Este nombre de usuario ya existe" });

    const hash = await bcrypt.hash(password, 10);
    const [ins] = await pool.query(
      "INSERT INTO usuarios (username, password, edad) VALUES (?,?,?)",
      [username, hash, age]
    );
    await pool.query("INSERT INTO estadisticas (usuario_id) VALUES (?)", [ins.insertId]);

    const user = await getProfile(ins.insertId);
    const token = sign(ins.insertId);
    res.json({ token, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error de servidor" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Faltan campos" });

    const [rows] = await pool.query("SELECT id, password FROM usuarios WHERE username = ?", [username]);
    if (!rows.length) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });

    const ok = await bcrypt.compare(password, rows[0].password);
    if (!ok) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });

    await pool.query("UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = ?", [rows[0].id]);

    const user = await getProfile(rows[0].id);
    const token = sign(rows[0].id);
    res.json({ token, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error de servidor" });
  }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const user = await getProfile(req.userId);
    res.json({ user });
  } catch {
    res.status(500).json({ error: "Error al cargar perfil" });
  }
});

app.post("/api/progress", auth, async (req, res) => {
  try {
    const { nivel, problemaIndex, correcto } = req.body;
    if ([nivel, problemaIndex].some((v) => v === undefined))
      return res.status(400).json({ error: "Datos incompletos" });

    await pool.query(
      "INSERT INTO progreso (usuario_id, nivel, problema_index, correcto) VALUES (?,?,?,?)",
      [req.userId, nivel, problemaIndex, !!correcto]
    );

    // Recalcular estadísticas
    const [[agg]] = await pool.query(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN correcto=1 THEN 1 ELSE 0 END) aciertos,
              SUM(CASE WHEN correcto=0 THEN 1 ELSE 0 END) fallos
       FROM progreso WHERE usuario_id = ?`,
      [req.userId]
    );
    const total = agg.total || 0, aciertos = agg.aciertos || 0, fallos = agg.fallos || 0;

    let nivel_actual = 1;
    if (aciertos >= 25) nivel_actual = 5;
    else if (aciertos >= 15) nivel_actual = 4;
    else if (aciertos >= 10) nivel_actual = 3;
    else if (aciertos >= 5) nivel_actual = 2;

    const progreso_general = Math.min(100, (aciertos / 50) * 100);
    const [[nivelAgg]] = await pool.query(
      `SELECT COUNT(*) problemas_nivel,
              SUM(CASE WHEN correcto=1 THEN 1 ELSE 0 END) aciertos_nivel
       FROM progreso WHERE usuario_id = ? AND nivel = ?`,
      [req.userId, nivel_actual]
    );
    const pn = nivelAgg.problemas_nivel || 0, an = nivelAgg.aciertos_nivel || 0;
    const progreso_nivel_actual = pn ? (an / pn) * 100 : 0;

    await pool.query(
      `INSERT INTO estadisticas (usuario_id, progreso_general, progreso_nivel_actual, nivel_actual,
                                 problemas_completados, aciertos, fallos, ultima_actualizacion)
       VALUES (?,?,?,?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE
         progreso_general=VALUES(progreso_general),
         progreso_nivel_actual=VALUES(progreso_nivel_actual),
         nivel_actual=VALUES(nivel_actual),
         problemas_completados=VALUES(problemas_completados),
         aciertos=VALUES(aciertos),
         fallos=VALUES(fallos),
         ultima_actualizacion=NOW()`,
      [req.userId, progreso_general, progreso_nivel_actual, nivel_actual, total, aciertos, fallos]
    );

    res.json({ success: true, stats: { progreso_general, progreso_nivel_actual, nivel_actual, problemas_completados: total, aciertos, fallos } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al guardar progreso" });
  }
});

app.post("/api/video-view", auth, async (req, res) => {
  try {
    const { nivelVideo, tituloVideo } = req.body;
    if (!nivelVideo || !tituloVideo) return res.status(400).json({ error: "Datos incompletos" });

    await pool.query(
      `INSERT INTO videos_vistos (usuario_id, nivel_video, titulo_video)
       VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE fecha_visto = NOW()`,
      [req.userId, nivelVideo, tituloVideo]
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al registrar video visto" });
  }
});

app.listen(PORT, () => console.log("API corriendo en puerto", PORT));
