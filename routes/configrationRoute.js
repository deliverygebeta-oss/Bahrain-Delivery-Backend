import express from "express";
import { protect } from "../controllers/authController.js";
import { getFirbaseConfigration } from "../firebase.js";

const router = express.Router();

router.get("/getFirebaseConfig", protect, getFirbaseConfigration);

export default router;
