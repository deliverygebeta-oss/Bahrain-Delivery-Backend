import express from 'express';
import multer from 'multer';
import { protect, restrictTo } from '../controllers/authController.js';
import * as restaurantController from '../controllers/restaurantController.js';
import uploadRestaurantImage from '../middleware/uploadRestaurantImageToCloudinary.js';

const router = express.Router();

// ----------------------------
// MULTER CONFIG
// ----------------------------
const multerStorage = multer.memoryStorage();
const upload = multer({ storage: multerStorage });

/* ============================================================
   ⚡ STATIC ROUTES — MUST COME BEFORE ANY "/:id"
============================================================ */

// Admin: Get complete list
router.get(
  '/admin/list',
  protect,
  restrictTo('Admin'),
  restaurantController.getAllRestaurantsForAdmin
);

// routes/adminRoutes.js or restaurantRoutes.js
router.get("/restaurants/order-stats",  restaurantController.getRestaurantsWithOrderStats);

// Assign manager to restaurant
router.post(
  '/assign-manager',
  protect,
  restrictTo('Admin'),
  restaurantController.assignRestaurantManager
);

// Update restaurant location
router.patch(
  '/location/:restaurantId',
  protect,
  restrictTo('Admin', 'Manager'),
  restaurantController.updateRestaurantLocation
);

// Restaurants by manager
router.get(
  '/by-manager',
  protect,
  restrictTo('Manager', 'Admin'),
  restaurantController.getRestaurantsByManagerId
);

// Restaurants near coordinates
router.get(
  '/distance-from-coords',
  protect,
  restaurantController.getRestaurantsWithDistanceFromCoords
);

/* ============================================================
   ⚡ PUBLIC + ADMIN ROUTES
============================================================ */

router
  .route('/')
  .get(restaurantController.getAllRestaurants)
  .post(
    protect,
    restrictTo('Admin'),
    upload.single('image'),
    uploadRestaurantImage,
    restaurantController.createRestaurant
  );

/* ============================================================
   ⚡ DYNAMIC ROUTES — MUST COME LAST
============================================================ */

// Restaurant CRUD
router
  .route('/:id')
  .get(restaurantController.getRestaurant)
  .patch(
    protect,
    restrictTo('Manager', 'Admin'),
    upload.single('image'),
    uploadRestaurantImage,
    restaurantController.updateRestaurant
  )
  .delete(
    protect,
    restrictTo('Manager', 'Admin'),
    restaurantController.deleteRestaurant
  )
  .post(
    protect,
    restrictTo('Admin'),
    restaurantController.activateRestaurant
  );

// Restaurant menu (must be after /:id)
router.get('/:id/menu', protect, restaurantController.getRestaurantWithMenu);

export default router;
