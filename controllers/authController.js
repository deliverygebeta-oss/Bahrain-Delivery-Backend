import { parsePhoneNumber } from 'libphonenumber-js';
import { promisify } from 'util';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import User from '../models/userModel.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/appError.js';
import Restaurant from '../models/restaurantModel.js';
import AfroMessageService from '../utils/AfroMessageService.js';

// Initialize AfroMessage service
const afroMessageService = new AfroMessageService();

// =======================
// Helper Functions
// =======================

// 📞 Normalize Ethiopian phone number
export const normalizePhone = (phone) => {
  try {
    const phoneNumber = parsePhoneNumber(phone, 'ET');
    if (!phoneNumber.isValid()) {
      throw new AppError('Invalid phone number format', 400);
    }
    return phoneNumber.format('E.164'); // Returns e.g., "+251912345678"
  } catch (err) {
    throw new AppError('Invalid phone number format', 400);
  }
};

// 🔐 JWT helpers
const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });

const createSendToken = (user, statusCode, res) => {
  const token = signToken(user._id);
  const cookieOptions = {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
    ),
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  };

  res.cookie('jwt', token, cookieOptions);

  user.password = undefined;
  user.passwordConfirm = undefined;

  res.status(statusCode).json({
    status: 'success',
    message: 'Logged in successfully',
    token: token,
    data: { user },
  });
};

// 🛠️ Reusable OTP sender
const sendVerificationMessage = async (phone) => {
  const result = await afroMessageService.sendOTP(phone, {
    codeLength: 6,
    codeType: 0,
    ttlSeconds: 300,
    messagePrefix: 'Your verification code is',
    messagePostfix: '. Valid for 5 minutes.',
    spacesBeforeCode: 1
  });

  if (!result.success) {
    throw new AppError(result.error || 'Failed to send OTP', 500);
  }

  return {
    status: 'success',
    data: {
      message: `OTP sent to ${phone}`,
      verificationId: result.verificationId
    }
  };
};


// ✅ define the sendOTP function properly
export const sendOTP = async (phone) => {
  try {
    if (!phone) throw new AppError('Phone number is required', 400);

    // Normalize the phone number
    const normalizedPhone = normalizePhone(phone);

    // Send OTP using your AfroMessage service
    const response = await sendVerificationMessage(normalizedPhone);

    return {
      status: 'success',
      message: 'OTP sent successfully',
      phone: normalizedPhone,
      response,
    };
  } catch (error) {
    throw new AppError(error.message || 'Failed to send OTP', 500);
  }
};

// ✅ 2. Verify OTP
export const verifyOTP = [
  body('phone').notEmpty().withMessage('Phone number is required'),
  body('code').notEmpty().withMessage('OTP code is required'),
  body('verificationId').optional(),
  catchAsync(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

    const { phone, code, verificationId } = req.body;
    const normalizedPhone = normalizePhone(phone);

    const result = await afroMessageService.verifyOTP(
      code,
      normalizedPhone,
      verificationId
    );

   
    if (!result.success || !result.verified) {
      const errorMessage =
        typeof result.error === 'string'
          ? result.error
          : result.error?.message || 'Invalid or expired OTP';

      return next(new AppError(errorMessage, 400));
    }

    const user = await User.findOne({ phone: normalizedPhone });
    if (!user) return next(new AppError('User not found', 404));

    if (!user.isPhoneVerified) {
      user.isPhoneVerified = true;
      await user.save({ validateBeforeSave: false });
    }
      // 🎫 Send JWT token immediately after successful verification
    createSendToken(user, 200, res);
  }),
];


// 📝 3. Signup
export const signup = [
  body('phone').notEmpty().withMessage('Phone number is required'),
  catchAsync(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

    const { phone } = req.body;
    const normalizedPhone = normalizePhone(phone);
    
    // Check if user already exists
    const existingUser = await User.findOne({ phone: normalizedPhone });
    if (existingUser && existingUser.isPhoneVerified) {
      return next(new AppError('User already exists. Please login.', 400));
    }

    const response = await sendVerificationMessage(normalizedPhone);
    console.log('OTP sent response:', response);
    res.status(200).json({ 
      status: 'pending', 
      message: response.data.message,
      phone: normalizedPhone,
      verificationId: response.data.verificationId
    });
  }),
];

// ✅ 4. Verify Signup & Create User (OTP as initial password)
export const verifySignupOTP = [
  body('phone').notEmpty().withMessage('Phone number is required'),
  body('code').notEmpty().withMessage('OTP code is required'),
  body('password').notEmpty().withMessage('Password is required')(),
  body('passwordConfirm').notEmpty().withMessage('Password Confirm is required')(),
  body('verificationId').optional(),
  catchAsync(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

    const { phone, code, verificationId,password,passwordConfirm } = req.body;
    const normalizedPhone = normalizePhone(phone);

    const result = await afroMessageService.verifyOTP(
      code,
      normalizedPhone,
      verificationId
    );

    if (!result.success || !result.verified) {
      return next(new AppError(result.error || 'OTP invalid or expired', 400));
    }

    
    // New user - use OTP code as initial password
    const user = await User.create({
      phone: normalizedPhone,
      password: password,          // Use OTP as initial password
      passwordConfirm: passwordConfirm,   // Confirm with same OTP
      isPhoneVerified: true,
      role: 'Customer',
      requirePasswordChange: true  // Flag to force password change
    });

    createSendToken(user, 201, res);
  }),
];

// 🔑 5. Login
export const login = [
  body('phone').notEmpty().withMessage('Phone number is required'),
  body('password').notEmpty().withMessage('Password is required'),
  catchAsync(async (req, res, next) => {
    // 🧩 Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

    const { phone, password } = req.body;
    const normalizedPhone = normalizePhone(phone);

    // 🔍 Find user
    const user = await User.findOne({ phone: normalizedPhone }).select('+password');
    if (!user) return next(new AppError('No user found with that phone number', 404));

    // 🔑 Check password
    const isCorrect = await user.correctPassword(password, user.password);
    if (!isCorrect) return next(new AppError('Invalid credentials', 401));

    // 📱 If not verified, send OTP and return it directly
    if (!user.isPhoneVerified) {
      const otpResponse = await sendVerificationMessage(normalizedPhone);
      return res.status(200).json(otpResponse);
    }

    // ✅ If verified, login user normally
    createSendToken(user, 200, res);
  }),
];

// 🚪 6. Logout
export const logout = catchAsync(async (req, res, next) => {
  res.cookie('jwt', 'loggedout', {
    expires: new Date(Date.now() + 1000),
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
  res.status(200).json({ status: 'success', message: 'Logged out successfully' });
});

// 👤 7. Get Me
export const getMe = catchAsync(async (req, res, next) => {
  // 🔹 1. Get token from cookie or Authorization header
  let token = null;

  if (req.cookies?.jwt) {
    token = req.cookies.jwt;
  } else if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer ')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  // 🔹 2. If no token found
  if (!token) {
    return next(new AppError('You are not logged in', 401));
  }

  // 🔹 3. Verify token
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return next(new AppError('Invalid or expired token', 401));
  }

  // 🔹 4. Find user
  const user = await User.findById(decoded.id).select('-password');
  if (!user) {
    return next(new AppError('User not found', 404));
  }

  // 🔹 5. If user is Manager, get their restaurant
  let restaurant = null;
  if (user.role === 'Manager') {
    restaurant = await Restaurant.findOne({ managerId: user._id });
  }

  // 🔹 6. Send response
  res.status(200).json({
    status: 'success',
    data: {
      user,
      restaurant: restaurant
        ? { id: restaurant._id, name: restaurant.name }
        : null,
    },
  });
});


// 🛡️ 8. Protect Route Middleware
export const protect = catchAsync(async (req, res, next) => {
  let token;
  if (req.headers.authorization?.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies?.jwt) {
    token = req.cookies.jwt;
  }
  if (!token) return next(new AppError('Not logged in', 401));

  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);
  const user = await User.findById(decoded.id);
  if (!user) return next(new AppError('User no longer exists', 401));
  if (user.changedPasswordAfter(decoded.iat)) {
    return next(new AppError('Password changed recently. Please log in again.', 401));
  }
  req.user = user;
  next();
});

// 👮 9. Restrict To Roles Middleware
export const restrictTo = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return next(new AppError('Permission denied', 403));
  }
  next();
};

// 🔁 10. Request Password Reset OTP
export const requestPasswordResetOTP = [
  body('phone').notEmpty().withMessage('Phone number is required'),
  catchAsync(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

    const { phone } = req.body;
    const normalizedPhone = normalizePhone(phone);
    const user = await User.findOne({ phone: normalizedPhone });
    if (!user) return next(new AppError('User not found', 404));

    const response = await sendVerificationMessage(normalizedPhone);
    
    res.status(200).json({
      ...response,
      phone: normalizedPhone
    });
  }),
];

// 🔁 11. Reset Password With OTP
export const resetPasswordWithOTP = [
  body('phone').notEmpty().withMessage('Phone number is required'),
  body('code').notEmpty().withMessage('OTP code is required'),
  body('verificationId').optional(),
  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 4 }),
  body('passwordConfirm')
    .custom((value, { req }) => value === req.body.password)
    .withMessage('Passwords do not match'),
  catchAsync(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

    const { phone, code, verificationId, password, passwordConfirm } = req.body;
    const normalizedPhone = normalizePhone(phone);

    const result = await afroMessageService.verifyOTP(code, normalizedPhone, verificationId);
    console.log('OTP verification result:', result);

    if (!result.success || !result.verified) {
      const errorMessage =
        typeof result.error === 'string'
          ? result.error
          : result.error?.message || 'OTP invalid or expired';
      return next(new AppError(errorMessage, 400));
    }

    const user = await User.findOne({ phone: normalizedPhone }).select('+password');
    if (!user) return next(new AppError('User not found', 404));

    user.password = password;
    user.passwordConfirm = passwordConfirm;
    await user.save();

    createSendToken(user, 200, res);
  }),
];


// 🔁 12. Authenticated User Password Update
export const updatePassword = [
  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 4 })
    ,  body('passwordConfirm')
    .custom((value, { req }) => value === req.body.password)
    .withMessage('Passwords do not match'),
  catchAsync(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

    const user = await User.findById(req.user.id).select('+password');
    if (!user) return next(new AppError('User not found', 404));

    user.password = req.body.password;
    user.passwordConfirm = req.body.passwordConfirm;
    await user.save();

    createSendToken(user, 200, res);
  }),
];