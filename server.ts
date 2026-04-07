import express from "express";
import { createServer as createViteServer } from "vite";
import mongoose from "mongoose";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import bcrypt from "bcryptjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // MongoDB Connection
  let MONGODB_URI = process.env.MONGODB_URI;
  if (MONGODB_URI) {
    // Sanitize: trim whitespace and remove any surrounding quotes
    MONGODB_URI = MONGODB_URI.trim().replace(/^["']|["']$/g, '');
    
    if (!MONGODB_URI.startsWith('mongodb://') && !MONGODB_URI.startsWith('mongodb+srv://')) {
      console.error("CRITICAL: MONGODB_URI must start with 'mongodb://' or 'mongodb+srv://'. Current value starts with:", MONGODB_URI.substring(0, 10));
    } else {
      console.log("Attempting to connect to MongoDB...");
      mongoose.connect(MONGODB_URI)
        .then(() => console.log("Successfully connected to MongoDB"))
        .catch(err => {
          console.error("MongoDB connection error:", err.message);
          if (err.message.includes('ECONNREFUSED')) {
            console.error("HINT: 'localhost' won't work in the cloud. Use a MongoDB Atlas URI.");
          }
          if (err.message.includes('IP not whitelisted')) {
            console.error("HINT: Ensure your MongoDB Atlas IP Whitelist allows access from 0.0.0.0/0.");
          }
        });
    }
  } else {
    console.warn("MONGODB_URI is not defined. Please add it to your Secrets.");
  }

  // Health Check Endpoint
  app.get("/api/health", (req, res) => {
    const status = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    res.json({ 
      status, 
      readyState: mongoose.connection.readyState,
      hasUri: !!process.env.MONGODB_URI 
    });
  });

  // Schemas
  const userSchema = new mongoose.Schema({
    username: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['admin', 'student'], default: 'student' }
  }, { collection: 'users' });

  const eventSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String },
    date: { type: String },
    location: { type: String },
    capacity: { type: Number, default: 0 },
    registeredCount: { type: Number, default: 0 },
    fields: [{
      label: String,
      type: { type: String, enum: ['text', 'email', 'number', 'date'] }
    }],
    createdAt: { type: Date, default: Date.now }
  }, { collection: 'event' }); // Explicitly set to 'event' as requested

  const registrationSchema = new mongoose.Schema({
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    studentEmail: { type: String, required: true },
    details: { type: Map, of: String },
    registeredAt: { type: Date, default: Date.now }
  }, { collection: 'registrations' });

  const User = mongoose.model("User", userSchema);
  const Event = mongoose.model("Event", eventSchema);
  const Registration = mongoose.model("Registration", registrationSchema);

  // Auth Routes
  app.post("/api/auth/signup", async (req, res) => {
    try {
      const { username, email, password } = req.body;
      const hashedPassword = await bcrypt.hash(password, 10);
      const user = new User({ username, email, password: hashedPassword, role: 'student' });
      await user.save();
      res.status(201).json({ message: "User created successfully" });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Signup failed" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      const user = await User.findOne({ email });
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ message: "Invalid credentials" });
      }
      res.json({ username: user.username, email: user.email, role: user.role });
    } catch (err) {
      res.status(500).json({ message: "Login failed" });
    }
  });

  // Event Routes
  app.get("/api/events", async (req, res) => {
    try {
      const events = await Event.find().sort('-createdAt');
      res.json(events);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch events" });
    }
  });

  app.post("/api/events", async (req, res) => {
    try {
      if (!mongoose.connection.readyState) {
        return res.status(503).json({ error: "Database not connected. Please check your MONGODB_URI secret." });
      }
      const event = new Event(req.body);
      await event.save();
      res.status(201).json(event);
    } catch (err: any) {
      console.error("Event creation error:", err);
      res.status(400).json({ error: "Failed to create event", details: err.message });
    }
  });

  app.delete("/api/events/:id", async (req, res) => {
    try {
      await Event.findByIdAndDelete(req.params.id);
      res.json({ message: "Event deleted" });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete event" });
    }
  });

  // Registration Routes
  app.get("/api/registrations", async (req, res) => {
    try {
      const registrations = await Registration.find().populate('eventId').sort('-registeredAt');
      res.json(registrations);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch registrations" });
    }
  });

  app.post("/api/registrations", async (req, res) => {
    try {
      const { eventId, studentEmail, details } = req.body;
      const event = await Event.findById(eventId);
      if (!event) {
        return res.status(404).json({ error: "Event not found" });
      }

      if (event.capacity > 0 && event.registeredCount >= event.capacity) {
        return res.status(400).json({ error: "Event is full" });
      }

      const registration = new Registration({ eventId, studentEmail, details });
      await registration.save();

      event.registeredCount += 1;
      await event.save();

      res.status(201).json(registration);
    } catch (err: any) {
      console.error("Registration error:", err);
      res.status(400).json({ error: err.message || "Registration failed" });
    }
  });

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
