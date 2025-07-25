const bcrypt = require('bcryptjs');
const User = require('../models/User');
const CacheService = require('../services/cacheService');
const { upload } = require('../middleware/upload');
const path = require('path');
const fs = require('fs').promises;

// 회원가입
exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // 입력값 검증
    const validationErrors = [];
    
    if (!name || name.trim().length === 0) {
      validationErrors.push({
        field: 'name',
        message: '이름을 입력해주세요.'
      });
    } else if (name.length < 2) {
      validationErrors.push({
        field: 'name',
        message: '이름은 2자 이상이어야 합니다.'
      });
    }

    if (!email) {
      validationErrors.push({
        field: 'email',
        message: '이메일을 입력해주세요.'
      });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      validationErrors.push({
        field: 'email',
        message: '올바른 이메일 형식이 아닙니다.'
      });
    }

    if (!password) {
      validationErrors.push({
        field: 'password',
        message: '비밀번호를 입력해주세요.'
      });
    } else if (password.length < 6) {
      validationErrors.push({
        field: 'password',
        message: '비밀번호는 6자 이상이어야 합니다.'
      });
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: validationErrors
      });
    }

    // 🚀 LEAN 최적화: 사용자 중복 확인
    const existingUser = await User.findOne({ email })
      .select('_id') // ID만 확인하면 충분
      .lean(); // 순수 객체로 조회
      
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: '이미 가입된 이메일입니다.'
      });
    }

    // 비밀번호 암호화 및 사용자 생성 (새 생성 시에는 lean() 사용 불가)
    const newUser = new User({ 
      name, 
      email, 
      password,
      profileImage: '' // 기본 프로필 이미지 없음
    });

    const salt = await bcrypt.genSalt(10);
    newUser.password = await bcrypt.hash(password, salt);
    await newUser.save();

    res.status(201).json({
      success: true,
      message: '회원가입이 완료되었습니다.',
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        profileImage: newUser.profileImage
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: '회원가입 처리 중 오류가 발생했습니다.'
    });
  }
};

// 🚀 Redis 캐싱: 프로필 조회
exports.getProfile = async (req, res) => {
  try {
    // 🚀 캐시에서 먼저 확인
    const user = await CacheService.getUserInfo(req.user.id);
      
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    // 캐시 히트 헤더 설정
    res.set({
      'X-Cache': 'HIT',
      'Cache-Control': 'private, max-age=1800'
    });

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage
      }
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 조회 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 업데이트 (수정이 필요하므로 lean() 사용 불가)
exports.updateProfile = async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: '이름을 입력해주세요.'
      });
    }

    // 수정 작업이므로 lean() 사용 불가
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    user.name = name.trim();
    await user.save();

    // 🚀 사용자 정보 캐시 업데이트
    const updatedUserData = {
      _id: user._id,
      name: user.name,
      email: user.email,
      profileImage: user.profileImage,
      createdAt: user.createdAt
    };
    
    await CacheService.updateUserInfoCache(req.user.id, updatedUserData);

    // 🚀 관련 캐시들 무효화 (방 목록에 사용자 정보가 포함됨)
    await CacheService.invalidateRoomsListCache();

    res.json({
      success: true,
      message: '프로필이 업데이트되었습니다.',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage
      }
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 업데이트 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 이미지 업로드 (수정이 필요하므로 lean() 사용 불가)
exports.uploadProfileImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '이미지가 제공되지 않았습니다.'
      });
    }

    // 파일 유효성 검사
    const fileSize = req.file.size;
    const fileType = req.file.mimetype;
    const maxSize = 5 * 1024 * 1024; // 5MB

    if (fileSize > maxSize) {
      // 업로드된 파일 삭제
      await fs.unlink(req.file.path);
      return res.status(400).json({
        success: false,
        message: '파일 크기는 5MB를 초과할 수 없습니다.'
      });
    }

    if (!fileType.startsWith('image/')) {
      // 업로드된 파일 삭제
      await fs.unlink(req.file.path);
      return res.status(400).json({
        success: false,
        message: '이미지 파일만 업로드할 수 있습니다.'
      });
    }

    // 수정 작업이므로 lean() 사용 불가
    const user = await User.findById(req.user.id);
    if (!user) {
      // 업로드된 파일 삭제
      await fs.unlink(req.file.path);
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    // 기존 프로필 이미지가 있다면 삭제
    if (user.profileImage) {
      const oldImagePath = path.join(__dirname, '..', user.profileImage);
      try {
        await fs.access(oldImagePath);
        await fs.unlink(oldImagePath);
      } catch (error) {
        console.error('Old profile image delete error:', error);
      }
    }

    // 새 이미지 경로 저장
    const imageUrl = `/uploads/${req.file.filename}`;
    user.profileImage = imageUrl;
    await user.save();

    res.json({
      success: true,
      message: '프로필 이미지가 업데이트되었습니다.',
      imageUrl: user.profileImage
    });

  } catch (error) {
    console.error('Profile image upload error:', error);
    // 업로드 실패 시 파일 삭제
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch (unlinkError) {
        console.error('File delete error:', unlinkError);
      }
    }
    res.status(500).json({
      success: false,
      message: '이미지 업로드 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 이미지 삭제 (수정이 필요하므로 lean() 사용 불가)
exports.deleteProfileImage = async (req, res) => {
  try {
    // 수정 작업이므로 lean() 사용 불가
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    if (user.profileImage) {
      const imagePath = path.join(__dirname, '..', user.profileImage);
      try {
        await fs.access(imagePath);
        await fs.unlink(imagePath);
      } catch (error) {
        console.error('Profile image delete error:', error);
      }

      user.profileImage = '';
      await user.save();
    }

    res.json({
      success: true,
      message: '프로필 이미지가 삭제되었습니다.'
    });

  } catch (error) {
    console.error('Delete profile image error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 이미지 삭제 중 오류가 발생했습니다.'
    });
  }
};

// 회원 탈퇴 (삭제 작업이므로 lean() 사용 불가)
exports.deleteAccount = async (req, res) => {
  try {
    // 삭제 작업이므로 lean() 사용 불가
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    // 프로필 이미지가 있다면 삭제
    if (user.profileImage) {
      const imagePath = path.join(__dirname, '..', user.profileImage);
      try {
        await fs.access(imagePath);
        await fs.unlink(imagePath);
      } catch (error) {
        console.error('Profile image delete error:', error);
      }
    }

    await user.deleteOne();

    res.json({
      success: true,
      message: '회원 탈퇴가 완료되었습니다.'
    });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      message: '회원 탈퇴 처리 중 오류가 발생했습니다.'
    });
  }
};

// 🚀 Redis 캐싱: 사용자 검색 기능
exports.searchUsers = async (req, res) => {
  try {
    const { query, page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: '검색어를 입력해주세요.'
      });
    }

    const searchQuery = query.trim();
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    // 🚀 캐시에서 먼저 확인
    const cachedResult = await CacheService.getUserSearchResults(searchQuery, pageNum, limitNum);
    
    if (cachedResult) {
      // 캐시 히트 헤더 추가
      res.set({
        'X-Cache': 'HIT',
        'Cache-Control': 'private, max-age=600'
      });

      return res.json({
        success: true,
        ...cachedResult,
        cached: true
      });
    }

    // 캐시 미스 - DB에서 검색
    console.log(`[API] Search cache miss - searching users in DB: ${searchQuery}`);

    // 🚀 LEAN 최적화: 사용자 검색
    const users = await User.find({
      $or: [
        { name: { $regex: searchQuery, $options: 'i' } },
        { email: { $regex: searchQuery, $options: 'i' } }
      ]
    })
    .select('_id name email profileImage createdAt')
    .skip(skip)
    .limit(limitNum)
    .lean();

    // 총 개수 조회 (카운트만 필요하므로 더 가벼움)
    const totalCount = await User.countDocuments({
      $or: [
        { name: { $regex: searchQuery, $options: 'i' } },
        { email: { $regex: searchQuery, $options: 'i' } }
      ]
    });

    const responseData = {
      users: users.map(user => ({
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        hasMore: skip + users.length < totalCount
      }
    };

    // 🚀 결과를 캐시에 저장
    await CacheService.setUserSearchResults(searchQuery, pageNum, limitNum, responseData);

    // 캐시 미스 헤더 추가
    res.set({
      'X-Cache': 'MISS',
      'Cache-Control': 'private, max-age=600'
    });

    res.json({
      success: true,
      ...responseData,
      cached: false
    });

  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({
      success: false,
      message: '사용자 검색 중 오류가 발생했습니다.'
    });
  }
};

// 🚀 추가: 사용자 목록 조회 (lean() 최적화)
exports.getUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    // 🚀 LEAN 최적화: 사용자 목록 조회
    const users = await User.find({})
      .select('_id name email profileImage createdAt') // 필요한 필드만
      .sort({ createdAt: -1 }) // 최신 가입자부터
      .skip(skip)
      .limit(parseInt(limit))
      .lean(); // 순수 객체로 조회

    // 총 사용자 수 조회
    const totalCount = await User.countDocuments();

    res.json({
      success: true,
      users: users.map(user => ({
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage,
        joinedAt: user.createdAt
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount,
        hasMore: skip + users.length < totalCount
      }
    });

  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: '사용자 목록 조회 중 오류가 발생했습니다.'
    });
  }
};

module.exports = exports;