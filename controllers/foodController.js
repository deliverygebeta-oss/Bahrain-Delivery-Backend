// controllers/foodController.js

import Food from '../models/Food.js';
import FoodMenu from '../models/FoodMenu.js';
import Restaurant from '../models/restaurantModel.js';
import AppError from '../utils/appError.js';
import catchAsync from '../utils/catchAsync.js';
import cloudinary from '../utils/cloudinary.js';
import streamifier from 'streamifier';


// Get foods by menuId
export const getFoodsByMenuId = catchAsync(async (req, res, next) => {
  const { menuId } = req.params;

  if (!menuId) {
    return next(new AppError('Menu ID is required.', 400));
  }

  const foods = await Food.find({ menuId });

  if (!foods.length) {
    return next(new AppError('No foods found for the given menu ID.', 404));
  }

  res.status(200).json({
    status: 'success',
    results: foods.length,
    data: {
      foods
    }
  });
});

// Middleware: attach image URL to req.body.image
export const uploadFoodImageToCloudinary = catchAsync(async (req, res, next) => {
  if (!req.file) return next();

  const result = await uploadFromBuffer(req.file.buffer);
  req.body.image = result.secure_url;

  next();
});

// Validate manager/admin ownership of menu
const checkManagerAccess = async (menuId, user) => {
  const menu = await FoodMenu.findById(menuId);
  if (!menu) throw new AppError('Food menu not found', 404);
  const restaurant = await Restaurant.findById(menu.restaurantId);
  console.log(menu.restaurantId);
  if (!restaurant) throw new AppError('Restaurant not found', 404);
  if (restaurant.managerId.toString() !== user.id) {
    throw new AppError('Not authorized to access this menu', 403);
  }

  return { menu, restaurant };
};

// Utility to upload image buffer to Cloudinary
const uploadFromBuffer = (fileBuffer, folder = 'food_images', publicId) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: publicId,
        overwrite: true,
        resource_type: 'image',
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    streamifier.createReadStream(fileBuffer).pipe(stream);
  });
};

export const createFood = catchAsync(async (req, res, next) => {
  const { foodName, price, ingredients, instructions, cookingTimeMinutes, menuId } = req.body;

  // Validate required fields
  if (!foodName) return next(new AppError('Food name is required', 400));
  if (!price) return next(new AppError('Price is required', 400));
  if (!menuId) return next(new AppError('Menu ID is required', 400));

  // Validate price and cooking time
  if (isNaN(price) || Number(price) < 0) return next(new AppError('Price must be a non-negative number', 400));
  if (cookingTimeMinutes && (isNaN(cookingTimeMinutes) || Number(cookingTimeMinutes) < 1))
    return next(new AppError('Cooking time must be at least 1 minute', 400));

  // Check manager access
  await checkManagerAccess(menuId, req.user);

  // Normalize strings
  const normalizedFoodName = foodName.trim();
  const normalizedIngredients = ingredients ? ingredients.trim() : undefined;
  const normalizedInstructions = instructions ? instructions.trim() : undefined;

  // Handle image upload
  let imageCover;
  if (req.file) {
    try {
      const publicId = `food_${Date.now()}_${normalizedFoodName.replace(/\s+/g, '_')}`;
      const result = await uploadFromBuffer(req.file.buffer, 'food_images', publicId);
      imageCover = result.secure_url;
    } catch (error) {
      console.error('Cloudinary upload failed:', error);
      return next(new AppError(`Failed to upload food image: ${error.message}`, 500));
    }
  }

  const menu = await FoodMenu.findById(menuId);

  // Create the food item
  const newFood = await Food.create({
    foodName: normalizedFoodName,
    price,
    ingredients: normalizedIngredients,
    instructions: normalizedInstructions,
    cookingTimeMinutes,
    imageCover,
    menuId,
    restaurantId: menu.restaurantId
  });

  res.status(201).json({
    status: 'success',
    data: newFood,
  });
});
export const updateFood = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { foodName, price, ingredients, instructions, cookingTimeMinutes, status } = req.body;

  // 1️⃣ Find existing food
  const food = await Food.findById(id);
  if (!food) return next(new AppError('Food not found', 404));

  // 2️⃣ Check manager access
  await checkManagerAccess(food.menuId, req.user);

  // 3️⃣ Validate fields if provided
  if (price !== undefined && (isNaN(price) || Number(price) < 0))
    return next(new AppError('Price must be a non-negative number', 400));

  if(status && !['Available', 'Unavailable'].includes(status)){
    return next(new AppError('Invalid status value', 400));
  }else{
    food.status = status;
  }
  if (cookingTimeMinutes && (isNaN(cookingTimeMinutes) || Number(cookingTimeMinutes) < 1))
    return next(new AppError('Cooking time must be at least 1 minute', 400));

  // 4️⃣ Normalize input strings
  const normalizedFoodName = foodName ? foodName.trim() : food.foodName;
  const normalizedIngredients = ingredients ? ingredients.trim() : food.ingredients;
  const normalizedInstructions = instructions ? instructions.trim() : food.instructions;

  // 5️⃣ Handle optional image upload
  let imageCover = food.imageCover; // Keep the old image if no new upload
  if (req.file) {
    try {
      const publicId = `food_${Date.now()}_${normalizedFoodName.replace(/\s+/g, '_')}`;
      const result = await uploadFromBuffer(req.file.buffer, 'food_images', publicId);
      imageCover = result.secure_url;
    } catch (error) {
      console.error('Cloudinary upload failed:', error);
      return next(new AppError(`Failed to upload food image: ${error.message}`, 500));
    }
  }

  // 6️⃣ Update food
  food.foodName = normalizedFoodName;
  if (price !== undefined) food.price = price;
  food.ingredients = normalizedIngredients;
  food.instructions = normalizedInstructions;
  if (cookingTimeMinutes !== undefined) food.cookingTimeMinutes = cookingTimeMinutes;
  food.imageCover = imageCover;

  await food.save();

  // 7️⃣ Send response
  res.status(200).json({
    status: 'success',
    message: 'Food updated successfully',
    data: food,
  });
});

// Get all foods with optional filters
// Get all foods with optional filters
export const getAllFoods = catchAsync(async (req, res) => {
  const foods = await Food.find({ status: 'Available' })
  .populate({
    path: 'menuId',
    match: { active: true }, // ✅ only populate active menus
  })
  .populate({
    path: 'restaurantId',
    match: { active: true, isOpenNow: true }, // ✅ only populate active/open restaurants
    select: 'name isDeliveryAvailable active',
  });

// Remove foods where either menu or restaurant didn't match
const filteredFoods = foods.filter(
  food => food.menuId && food.restaurantId
);

res.status(200).json({
  status: 'success',
  results: filteredFoods.length,
  data: filteredFoods,
});
});



// Get single food item
export const getFood = catchAsync(async (req, res, next) => {
  const food = await Food.findById(req.params.id)
    .populate('menuId');

  if (!food) return next(new AppError('Food not found', 404));

  res.status(200).json({
    status: 'success',
    data: food
  });
});
// Soft delete food (mark as unavailable)
export const deleteFood = catchAsync(async (req, res, next) => {
  const food = await Food.findById(req.params.id);
  if (!food) return next(new AppError('Food not found', 404));

  await checkManagerAccess(food.menuId, req.user);

  food.status = 'Unavailable';
  await food.save();

  res.status(204).json({
    status: 'success',
    data: null
  });
});
