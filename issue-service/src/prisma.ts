import "./env";
import { PrismaClient } from "@prisma/client";

// Single shared client for the process - Prisma pools connections internally.
export const prisma = new PrismaClient();
