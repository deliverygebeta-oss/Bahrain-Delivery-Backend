import express from 'express';
import {
  createFood,
  getAllFoods,
  getFood,
  updateFood,
  deleteFood,
  uploadFoodImageToCloudinary,
  getFoodsByMenuId
} from '../controllers/foodController.js';

import { protect, restrictTo } from '../controllers/authController.js';
import upload from '../utils/upload.js';

const router = express.Router();

router
  .route('/')
  .get(getAllFoods)
  .post(
    protect,
    restrictTo('Admin', 'Manager'),
     upload.single('imageCover'),
   
    createFood
  );
router.get('/by-menu/:menuId', getFoodsByMenuId);
router
  .route('/:id')
  .get(getFood)
  .patch(
    protect,
    restrictTo('Admin', 'Manager'),
  upload.single('imageCover'),
    updateFood
  )
  .delete(protect, restrictTo('Admin', 'Manager'), deleteFood);

export default router;
 