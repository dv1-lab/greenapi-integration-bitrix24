import { Injectable, OnModuleInit } from "@nestjs/common";
import { PrismaClient, User, Instance, Prisma, InstanceState } from "@prisma/client";
import { StorageProvider } from "@green-api/greenapi-integration";
import { UserCreateData, UserUpdateData } from "../types";

@Injectable()
export class PrismaService
	extends PrismaClient
	implements OnModuleInit, StorageProvider<User, Instance, UserCreateData, UserUpdateData> {

	async onModuleInit() {
		await this.$connect();
	}

	async createUser(data: UserCreateData): Promise<User> {
		// При повторном вызове /oauth/install B24 не передаёт application_token
		// (он приходит отдельно через ONAPPINSTALL webhook), и в data.applicationToken
		// лежит временный плейсхолдер вида `temp_<ts>`. Если затереть им уже
		// существующий правильный applicationToken — Guard начнёт отбивать
		// все последующие ONIMCONNECTORMESSAGEADD, и outgoing-сообщения перестают
		// доходить. Поэтому при update applicationToken НЕ перезаписываем.
		const {applicationToken: _appTok, ...updateFields} = data;
		return this.user.upsert({
			where: {id: data.id},
			update: updateFields,
			create: {...data},
		});
	}

	async findUser(identifier: string): Promise<User | null> {
		return this.user.findUnique({
			where: {id: identifier},
			include: {instances: true},
		});
	}

	async updateUser(identifier: string, data: UserUpdateData): Promise<User> {
		return this.user.update({
			where: {id: identifier},
			data,
		});
	}

	async createInstance(instanceData: Prisma.InstanceCreateInput): Promise<Instance> {
		return this.instance.create({
			data: instanceData,
		});
	}

	async updateUserApplicationToken(
		userId: string,
		applicationToken: string,
	): Promise<User> {
		return this.user.update({
			where: {id: userId},
			data: {
				applicationToken,
			},
		});
	}

	async getInstance(idInstance: number | bigint): Promise<(Instance & { user: User }) | null> {
		return this.instance.findUnique({
			where: {idInstance: BigInt(idInstance)},
			include: {user: true},
		});
	}

	async removeInstance(idInstance: number | bigint): Promise<Instance> {
		return this.instance.delete({
			where: {idInstance: BigInt(idInstance)},
		});
	}

	async deleteUser(identifier: string): Promise<User> {
		return this.user.delete({
			where: {id: identifier},
		});
	}

	async updateInstanceState(idInstance: number | bigint, state: InstanceState): Promise<Instance> {
		return this.instance.update({
			where: {idInstance: BigInt(idInstance)},
			data: {stateInstance: state},
		});
	}

	async updateInstance(idInstance: number | bigint, data: Partial<Prisma.InstanceUpdateInput>): Promise<Instance> {
		return this.instance.update({
			where: {idInstance: BigInt(idInstance)},
			data,
		});
	}

	async getInstancesByUserId(userId: string): Promise<Instance[]> {
		return this.instance.findMany({
			where: {userId},
		});
	}

	async getInstanceByIdWithUser(idInstance: number | bigint): Promise<(Instance & { user: User }) | null> {
		return this.instance.findUnique({
			where: {idInstance: BigInt(idInstance)},
			include: {user: true},
		});
	}

	async updateUserTokens(
		userId: string,
		accessToken: string,
		refreshToken?: string,
		expiresAt?: Date,
	): Promise<User> {
		return this.user.update({
			where: {id: userId},
			data: {
				accessToken,
				...(refreshToken && {refreshToken}),
				...(expiresAt && {tokenExpiresAt: expiresAt}),
			},
		});
	}

	async getEntityPhonePref(
		portalDomain: string,
		entityType: string,
		entityId: string,
	): Promise<string | null> {
		const row = await this.entityPhonePref.findUnique({
			where: {portalDomain_entityType_entityId: {portalDomain, entityType, entityId}},
		});
		return row?.phone ?? null;
	}

	async setEntityPhonePref(
		portalDomain: string,
		entityType: string,
		entityId: string,
		phone: string,
	): Promise<void> {
		await this.entityPhonePref.upsert({
			where: {portalDomain_entityType_entityId: {portalDomain, entityType, entityId}},
			create: {portalDomain, entityType, entityId, phone},
			update: {phone},
		});
	}
}