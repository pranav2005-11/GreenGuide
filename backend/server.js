import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import crypto from "crypto";
import 'dotenv/config';
import { cropPlanRules } from './recommendationData.js';
import cron from 'node-cron';
import axios from 'axios';

const app = express();
const API_PORT = 5000;

// Middleware
app.use(express.json());
app.use(cors({
    origin: ["http://127.0.0.1:5500", "http://localhost:5500", "http://localhost:3000"],
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));

// Connect to MongoDB
mongoose.connect("mongodb://127.0.0.1:27017/mydb")
    .then(() => {
        console.log("✅ MongoDB Connected");
    })
    .catch(err => console.error("❌ MongoDB connection error:", err));

// Email configuration for notifications
const notificationTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});

// User Schema & Model
const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    password: String,
    location: { type: String },
    createdAt: { type: Date, default: Date.now },
    resetToken: String,
    resetTokenExpiry: Date,
    notificationPreferences: {
        emailNotifications: { type: Boolean, default: true },
        deadlineReminders: { type: Boolean, default: true }
    }
});

// Hash password before saving
userSchema.pre("save", async function (next) {
    if (!this.isModified("password")) return next();
    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (err) {
        next(err);
    }
});

const User = mongoose.model("User", userSchema);

// Dashboard Schema & Model
const dashboardSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    activities: [String],
    lastLogin: Date
});

const Dashboard = mongoose.model("Dashboard", dashboardSchema);

// Crop Schema & Model
const cropSchema = new mongoose.Schema({
    id: Number,
    name: String,
    type: String,
    image: String,
    season: String,
    soil: String,
    temperature: String,
    water: String,
    germination: String,
    maturity: String,
    harvest: String,
    overview: String,
    care: String
});

const Crop = mongoose.model("Crop", cropSchema);

// User-specific Crop Calendar Schema
const userCropSchema = new mongoose.Schema({
    userId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: "User", 
        required: true 
    },
    name: { type: String, required: true },
    type: { type: String, required: true },
    plantDate: { type: Date, required: true },
    growDuration: { type: Number, required: true },
    harvestDuration: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
    notificationsSent: {
        threeDay: { type: Boolean, default: false },
        oneDay: { type: Boolean, default: false },
        harvestDay: { type: Boolean, default: false }
    }
});

const UserCrop = mongoose.model("UserCrop", userCropSchema);

// ========================================================
// DEADLINE NOTIFICATION FUNCTIONS
// ========================================================

// Function to check crop deadlines and send notifications
async function checkCropDeadlines() {
    try {
        console.log('\n--- Checking crop deadlines ---');
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        // Get all user crops and populate user email and preferences
        const allCrops = await UserCrop.find().populate('userId', 'email name notificationPreferences');
        
        let notificationsSent = 0;
        
        for (const crop of allCrops) {
            if (!crop.userId || !crop.userId.email) continue;
            
            // Check if user has enabled notifications
            if (!crop.userId.notificationPreferences?.deadlineReminders) continue;
            
            const plantDate = new Date(crop.plantDate);
            const harvestDate = new Date(plantDate);
            harvestDate.setDate(harvestDate.getDate() + crop.growDuration);
            
            // Calculate days until harvest
            const timeDiff = harvestDate.getTime() - today.getTime();
            const daysUntilHarvest = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
            
            // Send notifications for 3 days, 1 day, and harvest day
            if (daysUntilHarvest === 3 && !crop.notificationsSent.threeDay) {
                await sendHarvestNotification(crop.userId.email, crop, daysUntilHarvest, crop.userId.name);
                crop.notificationsSent.threeDay = true;
                notificationsSent++;
            } else if (daysUntilHarvest === 1 && !crop.notificationsSent.oneDay) {
                await sendHarvestNotification(crop.userId.email, crop, daysUntilHarvest, crop.userId.name);
                crop.notificationsSent.oneDay = true;
                notificationsSent++;
            } else if (daysUntilHarvest === 0 && !crop.notificationsSent.harvestDay) {
                await sendHarvestNotification(crop.userId.email, crop, daysUntilHarvest, crop.userId.name);
                crop.notificationsSent.harvestDay = true;
                notificationsSent++;
            }
            
            // Save notification status
            await crop.save();
        }
        
        console.log(`✅ Deadline check completed. Sent ${notificationsSent} notifications.`);
    } catch (error) {
        console.error('❌ Error checking crop deadlines:', error);
    }
}

// Function to send harvest notification email
async function sendHarvestNotification(userEmail, crop, daysLeft, userName) {
    try {
        let subject, message, urgency;
        
        const harvestDate = new Date(crop.plantDate);
        harvestDate.setDate(harvestDate.getDate() + crop.growDuration);
        const formattedHarvestDate = harvestDate.toLocaleDateString('en-US', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        });

        if (daysLeft === 0) {
            subject = `🎉 Harvest Day: Your ${crop.name} is Ready!`;
            message = `Today is the day! Your ${crop.name} is ready for harvesting.`;
            urgency = "high";
        } else if (daysLeft === 1) {
            subject = `⏰ Harvest Tomorrow: ${crop.name}`;
            message = `Your ${crop.name} will be ready for harvest tomorrow (${formattedHarvestDate}).`;
            urgency = "medium";
        } else {
            subject = `📅 Harvest in ${daysLeft} Days: ${crop.name}`;
            message = `Your ${crop.name} will be ready for harvest in ${daysLeft} days (on ${formattedHarvestDate}).`;
            urgency = "low";
        }

        const mailOptions = {
            from: `"Crop Calendar Notifications" <${process.env.GMAIL_USER}>`,
            to: userEmail,
            subject: subject,
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                        .header { background: linear-gradient(135deg, #0e7a5a, #0e3b2e); color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
                        .content { background: #f8fbf9; padding: 20px; border-radius: 0 0 10px 10px; }
                        .crop-card { background: white; padding: 15px; margin: 15px 0; border-radius: 8px; border-left: 4px solid #0e7a5a; }
                        .urgency-high { border-left-color: #e74c3c; }
                        .urgency-medium { border-left-color: #f39c12; }
                        .urgency-low { border-left-color: #27ae60; }
                        .footer { text-align: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h1>🌱 Crop Calendar Reminder</h1>
                        </div>
                        <div class="content">
                            <p>Hello ${userName || 'Farmer'},</p>
                            <p>${message}</p>
                            
                            <div class="crop-card urgency-${urgency}">
                                <h3>Crop Details:</h3>
                                <p><strong>Crop Name:</strong> ${crop.name}</p>
                                <p><strong>Type:</strong> ${crop.type}</p>
                                <p><strong>Planted On:</strong> ${new Date(crop.plantDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                                <p><strong>Growth Duration:</strong> ${crop.growDuration} days</p>
                                <p><strong>Scheduled Harvest:</strong> ${formattedHarvestDate}</p>
                            </div>
                            
                            ${daysLeft === 0 ? `
                            <div style="background: #e8f5e8; padding: 15px; border-radius: 8px; margin: 15px 0;">
                                <h3>🎯 Action Required:</h3>
                                <p>Your crop is ready! Please proceed with harvesting at your earliest convenience.</p>
                            </div>
                            ` : ''}
                            
                            <p>Best regards,<br>The Crop Calendar Team</p>
                        </div>
                        <div class="footer">
                            <p>This is an automated notification from your Crop Calendar.</p>
                            <p>You can manage your notification preferences in your account settings.</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        };

        await notificationTransporter.sendMail(mailOptions);
        console.log(`✅ Harvest notification sent to ${userEmail} for ${crop.name} (${daysLeft} days)`);
        
    } catch (error) {
        console.error(`❌ Failed to send notification to ${userEmail}:`, error);
    }
}

// Function to send confirmation email when crop is added
async function sendCropAddedConfirmation(userEmail, crop, userName) {
    try {
        const harvestDate = new Date(crop.plantDate);
        harvestDate.setDate(harvestDate.getDate() + crop.growDuration);
        
        const mailOptions = {
            from: `"Crop Calendar Notifications" <${process.env.GMAIL_USER}>`,
            to: userEmail,
            subject: `✅ Crop Added: ${crop.name}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <div style="background: linear-gradient(135deg, #0e7a5a, #0e3b2e); color: white; padding: 20px; text-align: center;">
                        <h1>🌱 Crop Successfully Added</h1>
                    </div>
                    <div style="background: #f8fbf9; padding: 20px;">
                        <p>Hello ${userName || 'Farmer'},</p>
                        <p>Your crop <strong>${crop.name}</strong> has been successfully added to your calendar.</p>
                        
                        <div style="background: white; padding: 15px; margin: 15px 0; border-radius: 8px; border-left: 4px solid #0e7a5a;">
                            <h3>Crop Details:</h3>
                            <p><strong>Name:</strong> ${crop.name}</p>
                            <p><strong>Type:</strong> ${crop.type}</p>
                            <p><strong>Planting Date:</strong> ${new Date(crop.plantDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                            <p><strong>Growth Duration:</strong> ${crop.growDuration} days</p>
                            <p><strong>Expected Harvest:</strong> ${harvestDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                        </div>
                        
                        <p>You will receive automatic reminders 3 days before, 1 day before, and on the day of harvest.</p>
                        <p>Happy farming! 🌾</p>
                    </div>
                </div>
            `
        };

        await notificationTransporter.sendMail(mailOptions);
        console.log(`✅ Crop added confirmation sent to ${userEmail}`);
    } catch (error) {
        console.error('❌ Failed to send crop added confirmation:', error);
    }
}

// Schedule deadline checks to run daily at 8:00 AM
cron.schedule('0 8 * * *', async () => {
    console.log('\n=== Running scheduled crop deadline check ===');
    await checkCropDeadlines();
    console.log('=== Deadline check completed ===\n');
});

// ========================================================
// NOTIFICATION API ROUTES
// ========================================================

// Manual trigger endpoint for testing
app.post("/api/trigger-deadline-check", async (req, res) => {
    try {
        await checkCropDeadlines();
        res.json({ message: "Deadline check completed successfully" });
    } catch (error) {
        res.status(500).json({ error: "Failed to trigger deadline check" });
    }
});

// Update user notification preferences
app.put("/api/users/:id/notifications", async (req, res) => {
    try {
        const { emailNotifications, deadlineReminders } = req.body;
        const user = await User.findByIdAndUpdate(
            req.params.id,
            { 
                notificationPreferences: {
                    emailNotifications,
                    deadlineReminders
                }
            },
            { new: true }
        );
        
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, notificationPreferences: user.notificationPreferences });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get user notification preferences
app.get("/api/users/:id/notifications", async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: "User not found" });
        
        res.json({ 
            notificationPreferences: user.notificationPreferences || {
                emailNotifications: true,
                deadlineReminders: true
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========================================================
// USER-CROP API ROUTES (UPDATED WITH NOTIFICATIONS)
// ========================================================

// 1. POST: Add a new crop for a user
app.post("/api/user-crops", async (req, res) => {
    try {
        const { userId, name, type, plantDate, growDuration, harvestDuration } = req.body;
        
        // Basic validation
        if (!userId || !name || !type || !plantDate || !growDuration || !harvestDuration) {
            return res.status(400).json({ error: "Missing required crop fields." });
        }

        const newUserCrop = new UserCrop({
            userId,
            name,
            type,
            plantDate: new Date(plantDate),
            growDuration: parseInt(growDuration),
            harvestDuration: parseInt(harvestDuration),
            notificationsSent: {
                threeDay: false,
                oneDay: false,
                harvestDay: false
            }
        });

        const savedCrop = await newUserCrop.save();
        console.log(`✅ Crop added for user ${userId}: ${name}`);
        
        // Send immediate confirmation email
        try {
            const user = await User.findById(userId);
            if (user && user.notificationPreferences?.emailNotifications) {
                await sendCropAddedConfirmation(user.email, savedCrop, user.name);
            }
        } catch (emailError) {
            console.error('Failed to send confirmation email:', emailError);
        }
        
        res.status(201).json(savedCrop);
    } catch (err) {
        console.error("🔥 Error adding user crop:", err.message);
        res.status(500).json({ error: "Failed to add crop to database." });
    }
});

// 2. GET: Retrieve all crops for a specific user
app.get("/api/user-crops/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Ensure the ID is a valid MongoDB ObjectId
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ error: "Invalid User ID format." });
        }

        const userCrops = await UserCrop.find({ userId }).sort({ plantDate: 1 });
        console.log(`Fetched ${userCrops.length} crops for user ${userId}.`);
        res.json(userCrops);
    } catch (err) {
        console.error("🔥 Error fetching user crops:", err.message);
        res.status(500).json({ error: "Failed to retrieve crops." });
    }
});

// 3. DELETE: Delete a crop by its ID
app.delete("/api/user-crops/:id", async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid Crop ID format." });
        }

        const result = await UserCrop.findByIdAndDelete(id);

        if (!result) {
            return res.status(404).json({ message: "Crop not found." });
        }

        console.log(`🗑️ Crop deleted: ${id}`);
        res.json({ message: "Crop deleted successfully." });
    } catch (err) {
        console.error("🔥 Error deleting user crop:", err.message);
        res.status(500).json({ error: "Failed to delete crop." });
    }
});

// 4. PUT: Update an existing crop
app.put("/api/user-crops/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { name, type, plantDate, growDuration, harvestDuration } = req.body;
        
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid Crop ID format." });
        }
        
        const updatedCrop = await UserCrop.findByIdAndUpdate(
            id,
            { 
                name, 
                type, 
                plantDate, 
                growDuration, 
                harvestDuration,
                // Reset notifications when crop is updated
                notificationsSent: {
                    threeDay: false,
                    oneDay: false,
                    harvestDay: false
                }
            },
            { new: true, runValidators: true }
        );

        if (!updatedCrop) {
            return res.status(404).json({ message: "Crop not found." });
        }

        console.log(`✅ Crop updated: ${id}`);
        res.json(updatedCrop);
    } catch (err) {
        console.error("🔥 Error updating user crop:", err.message);
        res.status(500).json({ error: "Failed to update crop due to server error." });
    }
});

// ========================================================
// EXISTING ROUTES (KEEP ALL YOUR EXISTING CODE BELOW)
// ========================================================

// Function to safely insert all rules from recommendationData.js
async function importAllData() {
    const CropPlanData = mongoose.model("CropPlanData");
    try {
        const count = await CropPlanData.countDocuments();
        if (count < cropPlanRules.length) { 
            console.log(`ℹ️ DB currently has ${count} records. Inserting ${cropPlanRules.length} new rules...`);
            const results = await CropPlanData.insertMany(cropPlanRules, { ordered: false });
            console.log(`✅ Successfully inserted ${results.length} new crop recommendation rules.`);
        } else {
            console.log(`ℹ️ Crop Plan Data is up-to-date with ${count} records. Skipping insertion.`);
        }
    } catch (err) {
        console.error("❌ ERROR DURING DATA IMPORT:", err.message);
    }
}

// Existing API route to get all generic crops
app.get("/api/crops", async (req, res) => {
    try {
        const crops = await Crop.find();
        res.json(crops);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Routes (Signup, Login, etc.)
app.get("/", (req, res) => {
    res.send("Backend is running");
});

app.get("/api/users", async (req, res) => {
    try {
        const users = await User.find();
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/users", async (req, res) => {
    try {
        const { name, email, password, location } = req.body; 
        const newUser = new User({ name, email, password, location }); 
        await newUser.save();
        res.json({ message: "Signup successful", user: newUser });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/login", async (req, res) => {
    try {
        console.log("➡️ Login attempt:", req.body);
        const { email, password } = req.body;
        const user = await User.findOne({ email });

        if (!user) {
            console.log("❌ User not found:", email);
            return res.status(400).json({ error: "User not found" });
        }

        const isMatch = await bcrypt.compare(password.trim(), user.password);

        if (!isMatch) {
            return res.status(400).json({ error: "Invalid credentials" });
        }

        await Dashboard.findOneAndUpdate(
            { userId: user._id },
            { lastLogin: new Date() },
            { upsert: true }
        );

        console.log("✅ Login successful for:", user.email);

        res.json({
            success: true,
            message: "Login successful",
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                location: user.location
            }
        });
    } catch (err) {
        console.error("🔥 Login error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/activity", async (req, res) => {
    try {
        const { userId, activity } = req.body;
        await Dashboard.findOneAndUpdate(
            { userId },
            { $push: { activities: activity } },
            { upsert: true }
        );
        res.json({ message: "Activity saved!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/forgot-password", async (req, res) => {
    const { email } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: "User not found" });

        const token = crypto.randomBytes(32).toString("hex");
        user.resetToken = token;
        user.resetTokenExpiry = Date.now() + 15 * 60 * 1000;
        await user.save();

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.GMAIL_USER,
                pass: process.env.GMAIL_PASS
            }
        });

        const resetLink = `http://localhost:3000/reset?token=${token}`;

        await transporter.sendMail({
            from: `"The Green Guide" <${process.env.GMAIL_USER}>`,
            to: user.email,
            subject: "Password Reset Request",
            html: `<p>Click the link below to reset your password (valid 15 minutes):</p>
                  <a href="${resetLink}">${resetLink}</a>`
        });

        res.json({ message: "✅ Reset link sent to your email" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/reset-password", async (req, res) => {
    const { token, password } = req.body;
    try {
        const user = await User.findOne({
            resetToken: token,
            resetTokenExpiry: { $gt: Date.now() }
        });

        if (!user) return res.status(400).json({ error: "Invalid or expired token" });

        user.password = password;
        user.resetToken = undefined;
        user.resetTokenExpiry = undefined;
        await user.save();

        res.json({ message: "✅ Password updated successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Existing Crop Plan Data Schema and API
const cropPlanDataSchema = new mongoose.Schema({
    crop_name: { type: String, required: true, index: true },
    soil_type: { type: String, required: true },
    cultivation_method: { type: String, required: true },
    growth_stage: { type: String },
    fertilizer_type: { type: String },
    fertilizer_quantity: { type: String },
    pest_name: { type: String },
    management_type: { type: String },
    input_recommendation: { type: String },
    application_rate: { type: String },
    unit_of_measure: { type: String },
    estimated_unit_price_usd: { type: Number },
});

cropPlanDataSchema.index({ crop_name: 1, soil_type: 1, cultivation_method: 1 });
const CropPlanData = mongoose.model("CropPlanData", cropPlanDataSchema);

app.post("/api/crop-plan", async (req, res) => {
    try {
        const crop_name_clean = req.body.crop_name.trim();
        const soil_type_clean = req.body.soil_type.trim();
        const cultivation_method_clean = req.body.cultivation_method.trim();
        const land_area = req.body.land_area; 

        if (!crop_name_clean || !soil_type_clean || !cultivation_method_clean || !land_area || isNaN(land_area) || land_area <= 0) {
            return res.status(400).json({ error: "Missing required selection fields (crop, soil, method) or land area is invalid." });
        }

        console.log(`➡️ Generating plan for: ${crop_name_clean}, ${soil_type_clean}, ${cultivation_method_clean} on ${land_area} ha`);

        const recommendations = await CropPlanData.find({
            crop_name: new RegExp(`^${crop_name_clean}$`, 'i'),
            soil_type: new RegExp(`^${soil_type_clean}$`, 'i'),
            cultivation_method: new RegExp(`^${cultivation_method_clean}$`, 'i')
        });

        if (recommendations.length === 0) {
            return res.status(404).json({ message: "No specific plan found for these conditions. Returning general advice." });
        }
        
        let totalEstimatedCostUSD = 0;
        const fertilizerPlan = [];
        const pestPlan = [];

        recommendations.forEach(rec => {
            const getQuantityPerHectare = (quantityString) => {
                if (!quantityString) return 0;
                const match = quantityString.match(/(\d+\.?\d*)/);
                return match ? parseFloat(match[0]) : 0;
            };

            const quantityPerHectare = getQuantityPerHectare(rec.fertilizer_quantity || rec.application_rate);
            const totalQuantity = quantityPerHectare * parseFloat(land_area);
            const cost = totalQuantity * (rec.estimated_unit_price_usd || 0);

            if (rec.fertilizer_type) {
                fertilizerPlan.push({
                    stage: rec.growth_stage,
                    type: rec.fertilizer_type,
                    quantityPerHa: rec.fertilizer_quantity,
                    totalQuantityNeeded: totalQuantity.toFixed(2),
                    unit: rec.unit_of_measure,
                    estimatedCost: cost.toFixed(2)
                });
                totalEstimatedCostUSD += cost;
            } else if (rec.pest_name) {
                pestPlan.push({
                    pest: rec.pest_name,
                    type: rec.management_type,
                    input: rec.input_recommendation,
                    ratePerHa: rec.application_rate,
                    totalQuantityNeeded: totalQuantity.toFixed(2),
                    unit: rec.unit_of_measure,
                    estimatedCost: cost.toFixed(2)
                });
                totalEstimatedCostUSD += cost;
            }
        });

        console.log(`✅ Plan generated. Total estimated cost: $${totalEstimatedCostUSD.toFixed(2)}`);
        
        res.json({
            success: true,
            plan: {
                fertilizer: fertilizerPlan,
                pestsAndDiseases: pestPlan,
                totalCostUSD: totalEstimatedCostUSD.toFixed(2)
            }
        });

    } catch (err) {
        console.error("🔥 Error generating crop plan:", err.message);
        res.status(500).json({ error: "Failed to generate plan due to a server error." });
    }
});

app.get("/api/crops/unique", async (req, res) => {
    try {
        const uniqueCrops = await CropPlanData.distinct("crop_name");
        res.json(uniqueCrops.sort());
    } catch (err) {
        console.error("🔥 Error fetching unique crop names:", err.message);
        res.status(500).json({ error: "Failed to fetch crop list." });
    }
});

// Weather Integration
const getWeatherTransporter = () => nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});

async function checkWeatherAndNotify(userEmail, userCity) {
    const apiKey = process.env.OPENWEATHER_API_KEY;

    if (!apiKey) {
        console.error("❌ OPENWEATHER_API_KEY is missing in .env. Skipping weather check.");
        return;
    }
    
    if (!userCity || userCity.trim() === '') {
        console.log(`ℹ️ Skipping weather check for user ${userEmail}: No location provided.`);
        return;
    }

    try {
        const cleanedCity = userCity.trim();
        const url = `https://api.openweathermap.org/data/2.5/weather?q=${cleanedCity}&appid=${apiKey}&units=metric`;
        const response = await axios.get(url);
        const data = response.data;

        const condition = data.weather[0].description.toLowerCase();
        const temp = data.main.temp;
        const windSpeed = data.wind.speed;

        let badWeatherMessage = null;

        // 2. Define "Bad Weather" Logic for Farming
        if (condition.includes("rain") && data.rain && data.rain['1h'] >= 5) {
            badWeatherMessage = `Heavy rain expected (Condition: ${condition}). Consider delaying field work. 🌧️`;
        } else if (condition.includes("snow") || condition.includes("sleet") || temp < 3) {
            badWeatherMessage = `Frost/Freezing Alert! Temperature is ${temp}°C. Implement frost protection measures immediately. 🥶`;
        } else if (windSpeed > 15) {
            badWeatherMessage = `Strong Wind Warning! Wind speed is ${windSpeed} m/s. Secure trellises and avoid spraying. 🌬️`;
        } else if (temp > 40) {
            badWeatherMessage = `Extreme Heat Warning! Temperature is ${temp}°C. Ensure proper irrigation to prevent crop wilting. 🔥`;
        } else { // <--- TEMPORARY LINE ADDED HERE TO FORCE ALERT
            // 👇 TEMPORARY: FORCE ALERT MESSAGE
            badWeatherMessage = `🔥 **TEST ALERT TRIGGERED:** Current Temp is ${temp}°C in ${cleanedCity}. This confirms the system is fully operational.`;
        }
        
        if (badWeatherMessage) {
            const transporter = getWeatherTransporter();
            const mailOptions = {
                from: `"The Green Guide Alert" <${process.env.GMAIL_USER}>`,
                to: userEmail,
                // 👇 TEMPORARY: TEST SUBJECT
                subject: `🚨 TEST: Weather System Check for ${cleanedCity} - Green Guide`,
                html: `
                    <h3 style="color: #c82333;">Bad Weather Detected!</h3>
                    <p>Dear Farmer,</p>
                    <p>This is an automated alert for your monitored location, ${cleanedCity}.</p>
                    <p style="padding: 10px; border: 1px solid #c82333; background-color: #f8d7da;">
                        <strong>Current Alert:</strong> ${badWeatherMessage}
                    </p>
                    <p>Please check your fields and implement appropriate crop protection measures.</p>
                    <p>The Green Guide Team</p>
                `,
            };

            await transporter.sendMail(mailOptions);
            console.log(`✅ Email alert sent to ${userEmail} for ${cleanedCity}.`);
        } else {
            console.log(`ℹ️ Weather in ${cleanedCity} is favorable. No alert sent.`);
        }

    } catch (error) {
        console.error(`❌ Error checking weather or sending email for ${userCity}:`, error.message);
        if (error.response && error.response.status === 404) {
             console.error(`City not found: ${userCity}`);
        }
    }
}

// 👇 TEMPORARY: Runs every minute
cron.schedule('* * * * *', async () => {
    console.log('\n--- Running MINUTE-BY-MINUTE WEATHER TEST CHECK ---');
    try {
        const usersToAlert = await User.find({ 
            location: { $exists: true, $ne: null, $ne: '' } 
        }); 

        if (usersToAlert.length > 0) {
            console.log(`Checking weather for ${usersToAlert.length} users with saved locations.`);
            for (const user of usersToAlert) {
                await checkWeatherAndNotify(user.email, user.location); 
            }
        } else {
            console.log("No users with saved locations found to send weather alerts.");
        }
    } catch (error) {
        console.error("Error fetching users for weather check:", error.message);
    }
    console.log('--- Scheduled check finished ---');
});

// Update user profile
app.put("/api/users/:id", async (req, res) => {
    try {
        const { name, email } = req.body;
        const user = await User.findByIdAndUpdate(req.params.id, { name, email }, { new: true });
        if(!user) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, user });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Start Server
app.listen(API_PORT, () => {
    console.log(`🚀 Server running on http://localhost:${API_PORT}`);
    // Updated startup message to reflect current test schedule
    console.log(`⚠️ TEST MODE: Weather alerts are scheduled to run EVERY MINUTE.`);
    console.log(`✅ Deadline notifications are scheduled to run daily at 8:00 AM`);
});

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const authRoutes = require("./routes/authRoutes");

const app = express();

connectDB();

app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);

// ... your existing routes (e.g. recommendationData.js routes) stay as they are

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));