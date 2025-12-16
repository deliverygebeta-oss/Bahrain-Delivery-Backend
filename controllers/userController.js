import User from '../models/userModel.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/appError.js';
import { uploadImageToCloudinary } from '../utils/cloudinary.js';
import { normalizePhone,sendOTP} from './authController.js';
// Utility function to filter allowed fields
const filterObj = (obj, ...allowedFields) => {
  const newObj = {};
  Object.keys(obj).forEach((el) => {
    if (allowedFields.includes(el)) newObj[el] = obj[el];
  });
  return newObj;
};
// GET /api/v1/users
export const getAllUsers = catchAsync(async (req, res, next) => {
  const { role, active } = req.query;

  // Allowed roles for validation
  const validRoles = ['Customer', 'Manager', 'Delivery_Person', 'Admin'];

  // Validate role only if provided
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({
      status: 'fail',
      message: `Invalid role. Allowed roles: ${validRoles.join(', ')}`
    });
  }

  // Build dynamic query
  const query = {};
  if (role) query.role = role;
  if (active !== undefined) query.active = active === 'true';

  // Fetch users (middleware automatically excludes inactive unless active is specified)
  const users = await User.find(query);

  res.status(200).json({
    status: 'success',
    results: users.length,
    data: { users }
  });
});

// PATCH /api/v1/users/updateMe
export const updateMe = catchAsync(async (req, res, next) => {
  // 1️⃣ Prevent password updates here
  if (req.body.password || req.body.passwordConfirm) {
    return next(
      new AppError(
        'This route is not for password updates. Please use /updateMyPassword.',
        400
      )
    );
  }
  // 2️⃣ Handle image upload if file provided
  if (req.file) {
    const result = await uploadImageToCloudinary(req.file.buffer, {
      folder: 'profile_pictures',
      publicId: req.user.id.toString(),
      width: 600,
      height: 600,
      quality: 80, // balanced quality and size
    });
    req.body.profilePicture = result.url; // use secure URL
  }

  // 3️⃣ Filter out unwanted fields
  const filteredBody = filterObj(req.body, 'firstName', 'lastName', 'profilePicture');

  // 4️⃣ Update user document
  const updatedUser = await User.findByIdAndUpdate(req.user.id, filteredBody, {
    new: true,
    runValidators: true,
  });

  // 5️⃣ Send response
  res.status(200).json({
    status: 'success',
    data: {
      user: updatedUser,
    },
  });
});
// GET /api/v1/users/:id
export const getUser = catchAsync(async (req, res, next) => {
  const { id, phone, active } = req.query;

  // 1️⃣ Validate that at least one search parameter is provided
  if (!id && !phone && active === undefined) {
    return next(
      new AppError('Please provide at least one search parameter: id, phone, or active', 400)
    );
  }

  console.log("asdfads");
  const query = {};

  if (id) query._id = id;
  if (phone) query.phone = phone;
  if (active !== undefined) query.active = active === 'true';

  // 3️⃣ Execute appropriate query based on filters
  let users;
  let singleUser = false;

  // If searching by id or phone — these should return a single user
  if (id || phone) {
    const user = await User.findOne(query).select('-password -__v');
    if (!user) {
      return next(new AppError('No user found with the provided search criteria', 404));
    }
    users = [user]; // wrap in array for consistent response
    singleUser = true;
  } else {
    // If only filtering by "active" or other fields, return multiple
    users = await User.find(query).select('-password -__v');
    if (users.length === 0) {
      return next(new AppError('No users found with the provided search criteria', 404));
    }
  }

  // 4️⃣ Return clean JSON response
  res.status(200).json({
    status: 'success',
    results: users.length,
    data: {
      user: singleUser ? users[0] : users,
    },
  });
});


// POST /api/v1/users
export const createUser = catchAsync(async (req, res, next) => {
  const { phone, role, fcnNumber, deliveryMethod, firstName, lastName } = req.body;

  if (!phone) return next(new AppError('Phone number is required', 400));


  // ✅ Normalize phone number
  const normalizedPhone = normalizePhone(phone);
// ✅ Fixed
const user = await User.findOne({ phone: normalizedPhone });

  console.log(user)
  if (user) return next(new AppError('User with this phone number already exists', 400)); 
  const password = 1234; // default password for new users

  // ✅ Prepare base user data
  const userData = {
    firstName,
    lastName,
    phone: normalizedPhone,
    password,
    passwordConfirm: password,
    isPhoneVerified: false,
    role: role || 'Customer',
  };

  // ✅ Manager logic
  if (userData.role === 'Manager') {
    userData.firstLogin = true;

    if (!fcnNumber)
      return next(new AppError('FCN Number is required and must be alphanumeric for Managers', 400));

    userData.fcnNumber = fcnNumber;
  }

  // ✅ Delivery Person logic
  else if (userData.role === 'Delivery_Person') {
    userData.firstLogin = false;

    if (!fcnNumber)
      return next(new AppError('FCN Number is required and must be alphanumeric for Delivery_Person', 400));

    userData.fcnNumber = fcnNumber;

    if (!deliveryMethod)
      return next(new AppError('Delivery method is required for Delivery_Person', 400));

    userData.deliveryMethod = deliveryMethod;
  } else {
    userData.firstLogin = false;
  }

  // ✅ 1. Send OTP before user creation
  const otpResponse = await sendOTP(normalizedPhone);
  
  if (otpResponse.status !== 'success') {
    return next(new AppError(`Failed to send OTP: ${otpResponse.message}`, 500));
  }

  // ✅ 2. Create new user
  const newUser = await User.create(userData);

  // ✅ 3. Upload profile picture to Cloudinary (optional)
  if (req.file) {
    try {
      const publicId = newUser._id.toString();
      const result = await uploadImageToCloudinary(req.file.buffer, {
        folder: 'profile_pictures',
        publicId,
        width: 200,
        height: 200,
        quality: 80,
      });

      newUser.profilePicture = result.url;
      await newUser.save({ validateBeforeSave: false });
    } catch (err) {
      console.error('Cloudinary upload failed:', err);
      return next(new AppError(`Failed to upload profile picture: ${err.message}`, 500));
    }
  }

  // ✅ 4. Sanitize user output (hide sensitive info)
  const sanitizedUser = newUser.toObject();
  delete sanitizedUser.password;
  delete sanitizedUser.passwordConfirm;
  delete sanitizedUser.addresses;

  // ✅ 5. Send final response
  res.status(201).json({
    status: 'success',
    message: 'User created successfully. OTP sent for verification. User must verify phone and change password after login.',
    data: { user: sanitizedUser },
  });
});
// PATCH /api/v1/users/:id
export const updateUser = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  // 1️⃣ Find user (include inactive users)
  const user = await User.findById(id);
  if (!user) return next(new AppError('No user found with that ID', 404));

  // 2️⃣ Destructure allowed fields
  const { firstName, lastName, phone, role, fcnNumber, deliveryMethod} = req.body;

  // 3️⃣ Update basic fields
  if (firstName) user.firstName = firstName;
  if (lastName) user.lastName = lastName;

  // 4️⃣ Update phone
  if (phone && phone !== user.phone) {
    user.phone = phone;
    user.isPhoneVerified = false;

    await sendOTP(phone);
  }


  // 6️⃣ Update role and role-specific fields
  if (role) {
    const validRoles = ['Customer', 'Manager', 'Delivery_Person', 'Admin'];
    if (!validRoles.includes(role)) {
      return next(new AppError(`Invalid role. Allowed roles: ${validRoles.join(', ')}`, 400));
    }

    user.role = role;

    switch (role) {
      case 'Manager':
        if (fcnNumber) user.fcnNumber = fcnNumber;
        user.firstLogin = true;
        user.deliveryMethod = undefined;
        break;

      case 'Delivery_Person':
        if (!fcnNumber) return next(new AppError('FCN Number is required for Delivery_Person', 400));
        if (!deliveryMethod) return next(new AppError('Delivery method is required for Delivery_Person', 400));

        user.fcnNumber = fcnNumber;
        user.deliveryMethod = deliveryMethod;
        user.firstLogin = false;
        break;

      case 'Customer':
      case 'Admin':
        user.firstLogin = false;
        break;
    }
  }
  // 7️⃣ Update profile picture if uploaded
  if (req.file) {
    try {
      const publicId = user._id.toString(); 
      const result = await uploadImageToCloudinary(req.file.buffer, {
        folder: 'profile_pictures',
        publicId,
        width: 200,
        height: 200,
        quality: 80,
      });
      user.profilePicture = result.url;
    } catch (err) {
      console.error('Cloudinary upload failed:', err);
      return next(new AppError(`Failed to upload profile picture: ${err.message}`, 500));
    }
  }

  // 8️⃣ Save user
 await user.save({ validateBeforeSave: false });

  // 9️⃣ Send response
  const sanitizedUser = user.toObject();
  delete sanitizedUser.password;
  delete sanitizedUser.passwordConfirm;

  res.status(200).json({
    status: 'success',
    message: 'User updated successfully.',
    data: { user: sanitizedUser },
  });
});
// DELETE /api/v1/users/:id
export const deleteUser = catchAsync(async (req, res, next) => {
  const user = await User.findByIdAndDelete(req.params.id, { active: false });

  if (!user) {
    return next(new AppError('No user found with that ID', 404));
  }
  res.status(204).json({
    status: 'success',
    data: null
  });
});
export const activateUser = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  // 1️⃣ Find only inactive user by ID
  const user = await User.findOneAndUpdate(
    { _id: id, active: false }, // ✅ Only match inactive users
    { active: true },
    { new: true, runValidators: false }
  );

  // 2️⃣ If user not found or already active
  if (!user) {
    return next(
      new AppError('No inactive user found with that ID or user already active', 404)
    );
  }

  // 3️⃣ Send success response
  res.status(200).json({
    status: 'success',
    message: 'User has been activated successfully',
    data: {
      user
    }
  });
});
export const saveCurrentAddress = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const { name, label, additionalInfo, isDefault, location } = req.body;

  // ✅ 1. Validate required fields

  if (!label || !['Home', 'Work', 'Other'].includes(label)) {
    return next(new AppError('Address label must be Home, Work, or Other', 400));
  }

  if (!location?.lat || !location?.lng) {
    return next(new AppError('Coordinates (lat, lng) are required', 400));
  }

  // ✅ 2. Find user
  const user = await User.findById(userId);
  if (!user) return next(new AppError('User not found', 404));

  // ✅ 3. Enforce max address limit
  if (user.addresses.length >= 3) {
    return next(new AppError('You can only have up to 3 addresses', 400));
  }

  // ✅ 4. If this is the default address, unset existing defaults
  if (isDefault) {
    user.addresses.forEach(addr => (addr.isDefault = false));
  }

  // ✅ 5. Create address object (GeoJSON)
  const newAddress = {
    name,
    label,
    additionalInfo: additionalInfo || '',
    isDefault: isDefault || false,
    location: {
      type: 'Point',
      coordinates: [location.lng, location.lat] // [longitude, latitude]
    }
  };

  // ✅ 6. Add and save
  user.addresses.push(newAddress);
  await user.save({ validateBeforeSave: false }); // skip global validation for efficiency

  // ✅ 7. Send response
  res.status(201).json({
    status: 'success',
    message: 'Address added successfully',
    addresses: user.addresses
  });
});
export const getMyAddresses = catchAsync(async (req, res, next) => {
  const userId = req.user.id;

  // Fetch user addresses only
  const user = await User.findById(userId).select('addresses');
  if (!user) {
    return next(new AppError('User not found', 404));
  }

  res.status(200).json({
    status: 'success',
    addresses: user.addresses
  });
});
export const editAddress = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const addressId = req.params.addressId; // This should be the _id of the address subdocument

  // ✅ 1. Find user
  const user = await User.findById(userId);
  if (!user) return next(new AppError('User not found', 404));

  // ✅ 2. Find address using MongoDB _id
  const address = user.addresses.id(addressId);
  if (!address) return next(new AppError('Address not found', 404));

  // ✅ 3. Extract fields to update
  const { name, label, additionalInfo, isDefault, location } = req.body;

  // ✅ 4. Update allowed fields
  if (name) address.name = name;

  if (label) {
    if (!['Home', 'Work', 'Other'].includes(label)) {
      return next(new AppError('Invalid label: must be Home, Work, or Other', 400));
    }
    address.label = label;
  }

  if (additionalInfo) address.additionalInfo = additionalInfo;

  // ✅ 5. Update coordinates if provided
  if (location?.lat && location?.lng) {
    address.location = {
      type: 'Point',
      coordinates: [location.lng, location.lat]
    };
  }

  // ✅ 6. Handle default address
  if (isDefault) {
    user.addresses.forEach(addr => (addr.isDefault = false));
    address.isDefault = true;
  }

  // ✅ 7. Save changes
  await user.save({ validateBeforeSave: false });

  // ✅ 8. Respond
  res.status(200).json({
    status: 'success',
    message: 'Address updated successfully',
    address
  });
});
// DELETE /api/v1/users/address/:addressId
export const deleteAddress = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const addressId = req.params.addressId; // _id of the address subdocument

  // 1️⃣ Find user
  const user = await User.findById(userId);
  if (!user) return next(new AppError('User not found', 404));

  // 2️⃣ Find the index of the address
  const addressIndex = user.addresses.findIndex(addr => addr._id.toString() === addressId);
  if (addressIndex === -1) return next(new AppError('Address not found', 404));

  const [deletedAddress] = user.addresses.splice(addressIndex, 1); // remove address

  // 3️⃣ Ensure there is still one default address
  if (deletedAddress.isDefault && user.addresses.length > 0) {
    user.addresses[0].isDefault = true;
  }

  // 4️⃣ Save changes
  await user.save({ validateBeforeSave: false });

  // 5️⃣ Respond
  res.status(200).json({
    status: 'success',
    message: 'Address deleted successfully',
    addresses: user.addresses
  });
});

// =======================
// 🗑️ Account Deletion Request (Public - for Google Play compliance)
// =======================
export const requestAccountDeletion = catchAsync(async (req, res, next) => {
  const { phone, email, reason, feedback } = req.body;

  // Validate required fields
  if (!phone || !email) {
    return next(new AppError('Phone number and email are required', 400));
  }

  // Find user by phone or email
  const user = await User.findOne({
    $or: [{ phone }, { email }]
  });

  if (!user) {
    // Don't reveal if user exists or not for security
    return res.status(200).json({
      status: 'success',
      message: 'If an account exists with these details, a deletion request has been submitted.'
    });
  }

  // Mark user for deletion (soft delete approach)
  user.deletionRequested = true;
  user.deletionRequestedAt = new Date();
  user.deletionReason = reason || 'Not specified';
  user.deletionFeedback = feedback || '';
  await user.save({ validateBeforeSave: false });

  // Log the deletion request
  console.log(`🗑️ Account deletion requested: ${user.phone} - Reason: ${reason || 'Not specified'}`);

  res.status(200).json({
    status: 'success',
    message: 'Account deletion request submitted successfully. You will receive a verification code shortly.'
  });
});
