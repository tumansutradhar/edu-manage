const express = require('express');
const { body, validationResult } = require('express-validator');
const Attendance = require('../models/Attendance');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const { auth, authorize, checkApproval } = require('../middleware/auth');

const router = express.Router();

// @route   POST /api/attendance
// @desc    Mark attendance for a class
// @access  Private (Instructor only)
router.post('/', [
  auth,
  authorize('instructor'), // Removed 'admin' - only instructors can mark attendance
  checkApproval,
  body('courseId').notEmpty().withMessage('Course ID is required'),
  body('date').isISO8601().withMessage('Valid date is required'),
  body('students').isArray().withMessage('Students array is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation errors',
        errors: errors.array()
      });
    }

    const { courseId, date, students, classType, topic, duration } = req.body;

    // Verify course exists and instructor owns it
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    if (req.user.role !== 'instructor' || course.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to mark attendance for this course' });
    }

    // Check if attendance already exists for this date
    const existingAttendance = await Attendance.findOne({ course: courseId, date });
    if (existingAttendance) {
      return res.status(400).json({ message: 'Attendance already marked for this date' });
    }

    const attendance = new Attendance({
      course: courseId,
      date,
      instructor: req.user._id,
      students,
      classType,
      topic,
      duration
    });

    await attendance.save();

    // Update enrollment attendance counts
    for (const studentAttendance of students) {
      await Enrollment.findOneAndUpdate(
        { student: studentAttendance.student, course: courseId },
        {
          $inc: {
            'attendance.totalClasses': 1,
            'attendance.attendedClasses': studentAttendance.status === 'present' ? 1 : 0
          }
        }
      );
    }

    await attendance.populate([
      { path: 'course', select: 'title courseCode' },
      { path: 'students.student', select: 'firstName lastName email' }
    ]);

    res.status(201).json({
      message: 'Attendance marked successfully',
      attendance
    });
  } catch (error) {
    console.error('Mark attendance error:', error);
    res.status(500).json({ message: 'Server error while marking attendance' });
  }
});

// @route   GET /api/attendance/course/:courseId
// @desc    Get attendance records for a course
// @access  Private (Instructor/Admin)
router.get('/course/:courseId', [auth, authorize('instructor', 'admin')], async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    // Check if instructor owns this course
    if (req.user.role !== 'admin' && course.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const attendanceRecords = await Attendance.find({ course: req.params.courseId })
      .populate('students.student', 'firstName lastName email')
      .sort({ date: -1 });

    res.json(attendanceRecords);
  } catch (error) {
    console.error('Get attendance error:', error);
    res.status(500).json({ message: 'Server error while fetching attendance' });
  }
});

// @route   GET /api/attendance/student/:studentId
// @desc    Get attendance for a student
// @access  Private
router.get('/student/:studentId', auth, async (req, res) => {
  try {
    // Students can only view their own attendance
    if (req.user.role === 'student' && req.params.studentId !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const enrollments = await Enrollment.find({
      student: req.params.studentId,
      status: 'enrolled'
    }).populate('course', 'title courseCode');

    const attendanceByCourse = await Promise.all(enrollments.map(async (enrollment) => {
      const records = await Attendance.find({
        course: enrollment.course._id,
        'students.student': req.params.studentId
      })
        .populate('course', 'title courseCode')
        .sort({ date: -1 });

      const attendedClasses = records.reduce((count, record) => {
        const studentEntry = record.students.find(
          item => item.student.toString() === req.params.studentId
        );
        return count + (studentEntry && studentEntry.status === 'present' ? 1 : 0);
      }, 0);

      const totalClasses = records.length;
      const attendancePercentage = totalClasses > 0
        ? (attendedClasses / totalClasses) * 100
        : 0;

      return {
        course: enrollment.course,
        attendance: {
          totalClasses,
          attendedClasses,
          attendancePercentage
        },
        records: records.map(record => {
          const studentEntry = record.students.find(
            item => item.student.toString() === req.params.studentId
          );

          return {
            _id: record._id,
            date: record.date,
            classType: record.classType,
            topic: record.topic,
            duration: record.duration,
            status: studentEntry?.status || 'absent'
          };
        })
      };
    }));

    res.json(attendanceByCourse);
  } catch (error) {
    console.error('Get student attendance error:', error);
    res.status(500).json({ message: 'Server error while fetching student attendance' });
  }
});

module.exports = router;
