import FoodMenu from '../models/FoodMenu.js';
import Restaurant from '../models/restaurantModel.js';
import Food from '../models/Food.js';
import AppError from '../utils/appError.js';
import catchAsync from '../utils/catchAsync.js';
import APIFeatures from '../utils/apiFeatures.js'
// Helper function for authorization check
const checkRestaurantAuthorization = async (restaurantId, user) => {
  const restaurant = await Restaurant.findById(restaurantId).select('managerId active');
  
  if (!restaurant || !restaurant.active) {
    throw new AppError('Restaurant does not exist or is inactive', 404);
  }

  if (user.role !== 'Manager' && restaurant.managerId.toString() !== user.id) {
    throw new AppError('You are not authorized for this restaurant', 403);
  }

  return restaurant;
};

// CREATE a new menu
export const createMenu = catchAsync(async (req, res, next) => {
  const { restaurantId, menuType } = req.body;

  // Validate required fields
  if (!restaurantId) {
    return next(new AppError('Restaurant ID is required', 400));
  }

  // Authorization check
  await checkRestaurantAuthorization(restaurantId, req.user);

  // Check if menu type already exists for this restaurant
  if (menuType) {
    const existingMenu = await FoodMenu.findOne({
      restaurantId,
      menuType,
      active: true
    });

    if (existingMenu) {
      return next(new AppError(`Menu type '${menuType}' already exists for this restaurant`, 400));
    }
  }

  // Create menu
  const menu = await FoodMenu.create({
    restaurantId,
    menuType: menuType || 'other'
  });

  await menu.populate('restaurantId', 'name location');

  res.status(201).json({
    status: 'success',
    data: menu
  });
});

// GET all menus (with filtering, sorting, and pagination)
export const getAllMenus = catchAsync(async (req, res, next) => {
  const features = new APIFeatures(FoodMenu.find({ active: true }), req.query)
    .filter()
    .sort()
    .limitFields()
    .paginate();

  const menus = await features.query
    .populate('restaurantId', 'name location managerId')
    .lean();

  res.status(200).json({
    status: 'success',
    results: menus.length,
    data: menus
  });
});

// GET single menu with foods
export const getMenu = catchAsync(async (req, res, next) => {
  const menu = await FoodMenu.findOne({ 
    _id: req.params.id, 
    active: true 
  })
    .populate('restaurantId', 'name location')
    .lean();

  if (!menu) {
    return next(new AppError('Menu not found', 404));
  }

  // Get all foods for this menu
  const foods = await Food.find({ 
    menuId: menu._id, 
    active: true
  })
    .select('name description price category')
    .lean();

  res.status(200).json({
    status: 'success',
    data: {
      menu,
      foods,
      foodsCount: foods.length
    }
  });
});

export const getRestaurantMenus = catchAsync(async (req, res, next) => {
  const { restaurantId } = req.params;
  
  // Verify restaurant exists
  const restaurant = await Restaurant.findById(restaurantId).select('active');
  if (!restaurant || !restaurant.active) {
    return next(new AppError('Restaurant not found', 404));
  }

  const menus = await FoodMenu.find({ 
    restaurantId, 
    active: true 
  })
    .populate('restaurantId', 'name location')
    .sort({ createdAt: -1 })
    .lean();

  res.status(200).json({
    status: 'success',
    results: menus.length,
    data: menus
  });
});

// UPDATE menu
export const updateMenu = catchAsync(async (req, res, next) => {
  const menu = await FoodMenu.findOne({ 
    _id: req.params.id, 
    active: true 
  });

  if (!menu) {
    return next(new AppError('Menu not found', 404));
  }

  // Authorization check
  await checkRestaurantAuthorization(menu.restaurantId, req.user);

  // Prevent changing restaurantId
  const { restaurantId, ...updateData } = req.body;
  
  // Check if updating menuType would create a duplicate
  if (updateData.menuType && updateData.menuType !== menu.menuType) {
    const existingMenu = await FoodMenu.findOne({
      _id: { $ne: menu._id },
      restaurantId: menu.restaurantId,
      menuType: updateData.menuType,
      active: true
    });

    if (existingMenu) {
      return next(new AppError(`Menu type '${updateData.menuType}' already exists for this restaurant`, 400));
    }
  }

  // Update menu
  const updatedMenu = await FoodMenu.findByIdAndUpdate(
    req.params.id, 
    updateData, 
    {
      new: true,
      runValidators: true
    }
  ).populate('restaurantId', 'name location');

  res.status(200).json({
    status: 'success',
    data: updatedMenu
  });
});

// DELETE (soft delete) menu
export const deleteMenu = catchAsync(async (req, res, next) => {
  const menu = await FoodMenu.findOne({ 
    _id: req.params.id, 
    active: true 
  });

  if (!menu) {
    return next(new AppError('Menu not found', 404));
  }

  // Authorization check
  await checkRestaurantAuthorization(menu.restaurantId, req.user);

  // Soft delete
  menu.active = false;
  await menu.save({ validateBeforeSave: false });

  res.status(204).json({
    status: 'success',
    data: null
  });
});
