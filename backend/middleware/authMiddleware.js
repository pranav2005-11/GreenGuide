const User = require("../models/User");
const generateToken = require("../utils/generateToken");
const crypto = require("crypto");

// @route POST /api/auth/signup
const signup = async (req, res) => {
  try {
    const { fullName, email, mobileNumber, password, preferredLanguage } = req.body;

    if (!fullName || !email || !mobileNumber || !password) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ success: false, message: "Email already registered" });
    }

    const user = await User.create({
      fullName,
      email,
      mobileNumber,
      password,
      preferredLanguage,
    });

    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        preferredLanguage: user.preferredLanguage,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/auth/login
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password required" });
    }

    const user = await User.findOne({ email }).select("+password");
    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const token = generateToken(user._id);

    res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        preferredLanguage: user.preferredLanguage,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/auth/me
const getMe = async (req, res) => {
  res.status(200).json({ success: true, user: req.user });
};

// @route POST /api/auth/forgot-password
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ success: false, message: "No account with that email" });
    }

    const resetToken = crypto.randomBytes(20).toString("hex");
    user.resetPasswordToken = crypto.createHash("sha256").update(resetToken).digest("hex");
    user.resetPasswordExpiry = Date.now() + 30 * 60 * 1000; // 30 mins
    await user.save();

    // TODO: send resetToken via email service (e.g. Nodemailer)
    res.status(200).json({ success: true, message: "Reset link sent to email", resetToken });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/auth/reset-password/:token
const resetPassword = async (req, res) => {
  try {
    const hashedToken = crypto.createHash("sha256").update(req.params.token).digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpiry: { $gt: Date.now() },
    }).select("+resetPasswordToken +resetPasswordExpiry");

    if (!user) {
      return res.status(400).json({ success: false, message: "Invalid or expired reset token" });
    }

    user.password = req.body.password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpiry = undefined;
    await user.save();

    res.status(200).json({ success: true, message: "Password reset successful" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { signup, login, getMe, forgotPassword, resetPassword };