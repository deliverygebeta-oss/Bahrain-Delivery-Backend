import express from 'express';
import {
  createMenu,
  getAllMenus,
  getMenu,
  getRestaurantMenus,
  updateMenu,
  deleteMenu
} from '../controllers/foodMenuController.js';

import { protect, restrictTo } from '../controllers/authController.js';

const router = express.Router();

// Public routes
router.get('/', getAllMenus);
router.get('/:id', getMenu);

// Get all menus for a specific restaurant (public)
router.get('/restaurant/:restaurantId', getRestaurantMenus);

// Protected routes (Admin & Manager only)
router.use(protect, restrictTo('Admin', 'Manager'));

router.post('/', createMenu);
router.patch('/:id', updateMenu);
router.delete('/:id', deleteMenu);

export default router;