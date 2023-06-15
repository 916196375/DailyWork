/*
 * @Author: liuhongbo liuhongbo@dip-ai.com
 * @Date: 2023-06-14 15:53:15
 * @LastEditors: liuhongbo 916196375@qq.com
 * @LastEditTime: 2023-06-15 23:35:43
 * @FilePath: /DailyWork/src/task/task.service.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Task, User } from '@prisma/client';
import { PrismaService } from 'src/prisima.service';
import { DeleteTaskDto, TaskAddDto, TaskDetailDto, TaskListDto, UpdateTaskDto } from './dto/task.dto';
import { CommonResult } from 'src/types/common';
import { checkFinishTimeIsOverStartTime, formatTimeToShanghai, formatTimeToUtc } from 'src/utils/timeUtils';

@Injectable()
export class TaskService {
    constructor(
        private readonly prismaService: PrismaService
    ) { }

    async add(user: User, addTaskDto: TaskAddDto): Promise<CommonResult> {
        const addTaskData = formatTimeToUtc({ ...addTaskDto, creatorId: user.uid, assigneeId: user.uid })
        if (addTaskDto.startTime && addTaskDto.finishTime) {
            checkFinishTimeIsOverStartTime(addTaskDto.startTime, addTaskDto.finishTime)
        }
        try {
            const newTask = await this.prismaService.task.create({
                data: addTaskData
            })
            if (!newTask) {
                throw new HttpException('内部错误，任务创建失败！', HttpStatus.INTERNAL_SERVER_ERROR)
            }
            console.log('newTask', newTask)
            return {
                code: HttpStatus.OK,
                message: '任务创建成功！',
                result: null
            }
        } catch (error) {
            console.log('error', error)
            throw new HttpException('内部错误，任务创建失败！', HttpStatus.INTERNAL_SERVER_ERROR)
        }
    }

    async delete(user: User, deleteTaskDto: DeleteTaskDto): Promise<CommonResult> {
        const { taskId } = deleteTaskDto
        const successReturn:CommonResult = {
            code: HttpStatus.OK,
            message: '任务删除成功！',
            result: null
        }
        const task = await this.prismaService.task.findUnique({
            where: {
                taskId: taskId
            }
        })
        if (!task) {
            throw new HttpException('任务不存在！', HttpStatus.NOT_FOUND)
        }
        if (task.creatorId !== user.uid) {
            throw new HttpException('无权限删除！', HttpStatus.FORBIDDEN)
        }
        // 是否有子任务
        const taskChildren = await this.prismaService.task.findMany({
            where: {
                parentTaskId: taskId
            }
        })
        if (taskChildren.length) {
            try {
                await this.prismaService.$transaction(async (prisma) => {
                    // 更新子任务的父任务层级
                    await prisma.task.updateMany({
                        where: { OR: taskChildren.map(task => ({ taskId: task.taskId })) },
                        data: { parentTaskId: task.parentTaskId }
                    })
                    // 删除当前任务
                    await prisma.task.delete({
                        where: { taskId },
                    })
                })
                return successReturn
            } catch (error) {
                console.log('error', error)
                throw new HttpException('内部错误，任务删除失败！', HttpStatus.INTERNAL_SERVER_ERROR)
            }
        }
        try {
            const deleteTask = await this.prismaService.task.delete({
                where: {
                    taskId: taskId
                }
            })
            if (!deleteTask) {
                throw new HttpException('内部错误，任务删除失败！', HttpStatus.INTERNAL_SERVER_ERROR)
            }
            return successReturn
        } catch (error) {
            console.log('error', error)
            throw new HttpException('内部错误，任务删除失败！', HttpStatus.INTERNAL_SERVER_ERROR)
        }
    }


    async update(user: User, updateTaskDto: UpdateTaskDto): Promise<CommonResult> {
        const { taskId, parentTaskId } = updateTaskDto
        const { isMoveWithChildren, ...updateData } = updateTaskDto
        const task = await this.prismaService.task.findUnique({
            where: {
                taskId: taskId
            }
        })
        if (!task) {
            throw new HttpException('任务不存在！', HttpStatus.NOT_FOUND)
        }
        if (task.creatorId !== user.uid) {
            throw new HttpException('无权限修改！', HttpStatus.FORBIDDEN)
        }
        // 如果修改了开始时间或者结束时间，需要判断结束时间是否大于开始时间
        if ((updateTaskDto.startTime || task.startTime) && (updateTaskDto.finishTime || task.finishTime)) {
            checkFinishTimeIsOverStartTime(updateTaskDto.startTime || formatTimeToShanghai(task.startTime), updateTaskDto.finishTime || formatTimeToShanghai(task.finishTime))
        }

        // 移动任务,且带不带子任务一起移动
        if ('parentTaskId' in updateTaskDto && !isMoveWithChildren) {
            // 当前修改任务的子任务
            const currentChildrenTasks = await this.prismaService.task.findMany({
                where: {
                    parentTaskId: taskId
                }
            })
            if (currentChildrenTasks.length) {
                try {
                    const result = await this.prismaService.$transaction([
                        this.prismaService.task.updateMany({
                            where: {
                                OR: currentChildrenTasks.map(task => ({ taskId: task.taskId }))
                            },
                            data: {
                                parentTaskId: task.parentTaskId
                            }

                        }),
                        this.prismaService.task.update({
                            where: {
                                taskId: taskId,
                            },
                            data: { parentTaskId: parentTaskId }
                        })
                    ])
                    return {
                        code: HttpStatus.OK,
                        message: '任务修改成功！',
                        result: null
                    }
                } catch (error) {
                    console.log('error', error)
                    throw new HttpException('内部错误，任务修改失败！', HttpStatus.INTERNAL_SERVER_ERROR)
                }
            }
        }

        try {
            const updateTask = await this.prismaService.task.update({
                where: {
                    taskId: taskId
                },
                data: formatTimeToUtc(updateData)
            })
            if (!updateTask) {
                throw new HttpException('内部错误，任务修改失败！', HttpStatus.INTERNAL_SERVER_ERROR)
            }
            return {
                code: HttpStatus.OK,
                message: '任务修改成功！',
                result: null
            }
        } catch (error) {
            console.log('error', error)
            throw new HttpException('内部错误，任务修改失败！', HttpStatus.INTERNAL_SERVER_ERROR)
        }
    }

    async getProjectTaskList(taskListDto: TaskListDto): Promise<CommonResult<Task[]>> {
        try {
            const taskList = await this.prismaService.task.findMany({
                where: {
                    projectId: taskListDto.projectId,
                    parentTaskId: ''
                }
            })
            // 递归查询子任务，转换时间为上海时间
            const searchChildrenTask = (taskList: Task[]) => {
                return Promise.all(taskList.map(async (task: Task & { children: Task[] }) => {
                    task = formatTimeToShanghai(task) // 转换为上海时间
                    const childrenTasks = await this.prismaService.task.findMany({
                        where: {
                            parentTaskId: task.taskId
                        }
                    })
                    if (childrenTasks.length > 0) {
                        task.children = await searchChildrenTask(childrenTasks)
                    }
                    return task
                }))
            }
            const result = taskList.length === 0 ? [] : await searchChildrenTask(taskList)
            return {
                code: HttpStatus.OK,
                message: '任务列表获取成功！',
                result: result
            }
        } catch (error) {
            console.log('error', error)
            throw new HttpException('内部错误，任务列表获取失败！', HttpStatus.INTERNAL_SERVER_ERROR)
        }
    }


    async getTaskDetail(taskListDto: TaskDetailDto): Promise<CommonResult<Task>> {
        const { taskId } = taskListDto
        try {
            const task = await this.prismaService.task.findUnique({
                where: {
                    taskId: taskId
                }
            })
            if (!task) {
                throw new HttpException('任务不存在！', HttpStatus.NOT_FOUND)
            }
            return {
                code: HttpStatus.OK,
                message: '任务详情获取成功！',
                result: formatTimeToShanghai(task)
            }
        } catch (error) {
            console.log('error', error)
            throw new HttpException('内部错误，任务详情获取失败！', HttpStatus.INTERNAL_SERVER_ERROR)
        }
    }

}
